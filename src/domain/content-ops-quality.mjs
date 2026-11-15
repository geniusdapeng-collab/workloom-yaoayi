import { hashObject } from "./hash.mjs";
import { record, fail, contentOpsPackageHash, contentOpsReportHash, contentOpsReviewEnvelope, checkRef, contentOpsClaimFingerprint, SHA256 } from "./content-ops.mjs";
import { validateAdaptationPlan } from "./content-ops-plan.mjs";
import { qualityTextKeys } from "./content-ops-coverage.mjs";
import { checkerVersionForPackage, requiresTimelessGate, timelessReviewProblem } from "./content-ops-timeless.mjs";
export { qualityTextKeys } from "./content-ops-coverage.mjs";

export { FINAL_CHECKER_VERSION, TIMELESS_CHECKER_VERSION, checkerVersionForPackage, requiresTimelessGate, timelessGateForPackage, TIMELESS_CRITERIA, TIMELESS_CRITERION_IDS, TIMELESS_GATE_VERSION, timelessDimensionStatus, timelessReviewProblem } from "./content-ops-timeless.mjs";
export function candidateCheckContext(pkg) {
  return hashObject({ sourceEditionRefs: pkg.sourceEditionRefs, sourceClaimBindings: pkg.sourceClaimBindings, targetKey: pkg.targetKey, destinationIdentitySnapshot: pkg.destinationIdentitySnapshot, accountIdentitySnapshot: pkg.accountIdentitySnapshot, operatorProfileRef: pkg.operatorProfileRef, rulesRef: pkg.rulesRef, styleRef: pkg.styleRef, artifactRefs: pkg.artifactRefs, rightsReviewHashes: pkg.rightsReviewHashes, privacyReviewHashes: pkg.privacyReviewHashes, policyVersion: checkerVersionForPackage(pkg) });
}
export function assertCandidateCurrentBindings(state, candidate, { now = new Date() } = {}) {
  const pkg = candidate.package;
  const plan = record(state.adaptationPlans, candidate.planId);
  validateAdaptationPlan(state, plan.normalizedPlan, { now, expectedBindings: plan.inputBindings, targetKeys: [candidate.targetKey] });
  for (const artifact of pkg.artifactRefs) {
    const current = record(state.productionArtifacts, artifact.id, "ARTIFACT_MISSING");
    if (current.commitStatus !== "committed" || current.committed !== true || current.status !== "reviewed" || current.sha256 !== artifact.sha256 || current.rightsReviewHash !== artifact.rightsReviewHash || current.privacyReviewHash !== artifact.privacyReviewHash) fail(409, "RIGHTS_CHANGED", "最终附件字节或权利／隐私审核已改变。");
  }
  if (candidateCheckContext(pkg) !== candidate.checkContextHash) fail(409, "QUALITY_REPORT_STALE", "最终检查上下文已改变。");
}
export function validateCandidateForReview(state, candidateOrId, { packageHash, qualityReportHashes, reviewSnapshotHash, now = new Date(), assertCurrentBindings = true } = {}) {
  const candidate = typeof candidateOrId === "string" ? record(state.nativeCandidatePackages, candidateOrId, "CANDIDATE_NOT_FOUND") : candidateOrId;
  if (!candidate?.package || contentOpsPackageHash(candidate.package) !== candidate.packageHash || candidate.package.packageHash !== candidate.packageHash || packageHash && packageHash !== candidate.packageHash) fail(409, "QUALITY_REPORT_STALE", "最终包摘要不一致。");
  if (assertCurrentBindings) assertCandidateCurrentBindings(state, candidate, { now });
  const checkContextHash = candidateCheckContext(candidate.package);
  const allReports = state.contentQualityReports.filter(report => report.candidateId === candidate.id && report.checkedPackageHash === candidate.packageHash);
  const hashes = qualityReportHashes ?? candidate.qualityReportHashes ?? allReports.map(report => report.reportHash);
  if (!Array.isArray(hashes) || !hashes.length || new Set(hashes).size !== hashes.length || hashes.some(hash => !SHA256.test(hash))) fail(422, "QUALITY_RECHECK_REQUIRED", "必须有准确最终包的独立终检报告。");
  if (!hashes.includes(allReports.at(-1)?.reportHash)) fail(409, "QUALITY_REPORT_STALE", "较新的终检结果不能被旧通过报告覆盖。");
  const reports = hashes.map(hash => allReports.find(report => report.reportHash === hash));
  for (const report of reports) {
    const requiredTimeless = requiresTimelessGate(candidate.package);
    if (!report || contentOpsReportHash(report) !== report.reportHash || report.checkerVersion !== checkerVersionForPackage(candidate.package) || report.checkContextHash !== checkContextHash || report.status !== "passed" || !report.execution?.authorized || report.execution.subject === "" || (candidate.producerActors ?? []).includes(report.execution.subject) || (report.semanticFindings ?? []).some(finding => ["blocker", "major"].includes(finding.severity) && finding.resolved !== true)) fail(409, "QUALITY_REPORT_STALE", "终检版本、独立执行、覆盖、问题或报告摘要不满足要求。");
    if (["deterministic", "semantic", "media", "artistic"].some(dimension => report.dimensions?.[dimension] !== "passed")) fail(422, "QUALITY_RECHECK_REQUIRED", "最终终检有未通过或未核实维度。");
    const expectedTimeless = requiredTimeless ? "passed" : "not_applicable";
    if (report.dimensions?.timeless !== expectedTimeless) fail(422, "QUALITY_RECHECK_REQUIRED", requiredTimeless ? "文章或图文缺少十年内容检验。" : "非文章／图文目标的十年内容检验状态不正确。");
    if (requiredTimeless && timelessReviewProblem(report.timelessReview)) fail(422, "QUALITY_RECHECK_REQUIRED", timelessReviewProblem(report.timelessReview));
    if (report.execution.method === "checker") {
      const attempt = state.productionTaskAttempts.find(row => row.id === report.execution.attemptId), task = state.productionTaskBlueprints.find(row => row.taskId === attempt?.taskId), grant = state.workerGrants.find(row => row.id === report.execution.grantId);
      if (!attempt || attempt.status !== "succeeded" || task?.kind !== "quality.final" || attempt.workerId !== report.execution.workerId || attempt.grantId !== grant?.id || attempt.scopeHash !== grant?.scopeHash || grant?.scope.checker !== true || !grant.scope.jobIds.includes(candidate.jobId) || attempt.resolvedInputRefs.packageRef?.candidateId !== candidate.id || attempt.resolvedInputRefs.packageRef?.packageHash !== candidate.packageHash || attempt.resultRef?.reportHash !== report.reportHash || !attempt.reservationIds.some(id => state.modelBudgetReservations.some(row => row.id === id && row.attemptId === attempt.id && row.usageReceipt?.kind === "provider_response_usage"))) fail(409, "QUALITY_REPORT_STALE", "终检缺少可追溯的独立授权任务、准确输入与真实请求回执。");
    } else if (["local", "session"].includes(report.execution.method)) {
      if (!state.contentOpsRequests.some(request => request.result?.id === report.id && request.result?.reportHash === report.reportHash)) fail(409, "QUALITY_REPORT_STALE", "人工终检缺少管理员审核写入回执。");
    } else fail(409, "QUALITY_REPORT_STALE", "终检执行身份无效。");
    const covered = new Set(report.coverage?.textKeys ?? []);
    if (qualityTextKeys(candidate.package).some(key => !covered.has(key)) || candidate.package.artifactRefs.some(artifact => !(report.coverage?.artifactHashes ?? []).includes(artifact.sha256))) fail(422, "QUALITY_RECHECK_REQUIRED", "最终终检未覆盖全部文字与真实附件。");
  }
  const envelope = contentOpsReviewEnvelope(candidate.packageHash, hashes, checkContextHash), computed = hashObject(envelope);
  if (reviewSnapshotHash && reviewSnapshotHash !== computed || candidate.reviewSnapshotHash && candidate.reviewSnapshotHash !== computed) fail(409, "QUALITY_REPORT_STALE", "完整审核快照不一致。");
  return { candidate, package: candidate.package, envelope, reviewSnapshotHash: computed, reports, packageHash: candidate.packageHash, qualityReportHashes: hashes, checkContextHash, reviewEnvelope: envelope };
}
