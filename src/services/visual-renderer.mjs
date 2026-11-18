import { ApiError } from "../domain/errors.mjs";
import { hashObject } from "../domain/hash.mjs";
import sharp from "sharp";
import { createHash } from "node:crypto";

const VISUAL_KINDS = new Set(["architecture", "flow", "chart", "infographic"]);
const MAX_NODES = 40;
const MAX_EDGES = 80;
const MAX_POINTS = 30;

function text(value, name, maximum = 500, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === "")) return "";
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new ApiError(502, "VISUAL_SPEC_INVALID", `${name} 必须是非空且不超过 ${maximum} 字符的文本。`);
  }
  return value.trim();
}

function identifier(value, name) {
  const result = text(value, name, 80);
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(result)) throw new ApiError(502, "VISUAL_SPEC_INVALID", `${name} 格式无效。`);
  return result;
}

function finite(value, name) {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new ApiError(502, "VISUAL_SPEC_INVALID", `${name} 必须是有限数字。`);
  return result;
}

function lineCount(value, width) {
  return wrap(value, width).length;
}

function boundedLabel(value, name, lines, width, maximum = 500) {
  const result = text(value, name, maximum);
  if (lineCount(result, width) > lines) throw new ApiError(502, "VISUAL_SPEC_INVALID", `${name} 在当前版式中会溢出。`);
  return result;
}

export function normalizeVisualPlan(value, { articleHash = null, authorizedClaimIds = [] } = {}) {
  const visuals = value?.visuals;
  if (!Array.isArray(visuals) || visuals.length < 1 || visuals.length > 4) {
    throw new ApiError(502, "VISUAL_SPEC_INVALID", "视觉计划必须包含 1–4 个图形。");
  }
  return {
    visuals: visuals.map((row, index) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        throw new ApiError(502, "VISUAL_SPEC_INVALID", "视觉项必须是对象。");
      }
      const kind = text(row.kind, `visuals[${index}].kind`, 40);
      if (!VISUAL_KINDS.has(kind)) throw new ApiError(502, "VISUAL_SPEC_INVALID", `不支持视觉类型 ${kind}。`);
      const title = boundedLabel(row.title, `visuals[${index}].title`, 2, 36, 200);
      const alt = text(row.alt, `visuals[${index}].alt`, 1000);
      const caption = boundedLabel(row.caption, `visuals[${index}].caption`, 2, 52, 2000);
      const claimIds = Array.isArray(row.claimIds) ? [...new Set(row.claimIds.map(String))] : [];
      const authorized = new Set(authorizedClaimIds);
      if (claimIds.some(claimId => !authorized.has(claimId))) throw new ApiError(502, "VISUAL_SPEC_INVALID", "视觉图引用了任务未授权的 Claim。");
      if ((kind === "architecture" || kind === "flow") && (!Array.isArray(row.nodes) || !Array.isArray(row.edges))) {
        throw new ApiError(502, "VISUAL_SPEC_INVALID", "架构图和流程图必须提供 nodes 与 edges。");
      }
      if (kind === "architecture" || kind === "flow") {
        if (row.nodes.length < 2 || row.nodes.length > MAX_NODES || row.edges.length < 1 || row.edges.length > MAX_EDGES) {
          throw new ApiError(502, "VISUAL_SPEC_INVALID", "图节点或边数量无效。");
        }
        const nodes = row.nodes.map((node, nodeIndex) => ({
          id: identifier(node?.id, `visuals[${index}].nodes[${nodeIndex}].id`),
          label: boundedLabel(node?.label, `visuals[${index}].nodes[${nodeIndex}].label`, 2, 16, 160),
          group: node?.group === undefined ? null : boundedLabel(node.group, `visuals[${index}].nodes[${nodeIndex}].group`, 1, 24, 80),
        }));
        if (new Set(nodes.map(node => node.id)).size !== nodes.length) {
          throw new ApiError(502, "VISUAL_SPEC_INVALID", "图节点 ID 不得重复。");
        }
        const ids = new Set(nodes.map(node => node.id));
        const edges = row.edges.map((edge, edgeIndex) => {
          const from = identifier(edge?.from, `visuals[${index}].edges[${edgeIndex}].from`);
          const to = identifier(edge?.to, `visuals[${index}].edges[${edgeIndex}].to`);
          if (!ids.has(from) || !ids.has(to)) throw new ApiError(502, "VISUAL_SPEC_INVALID", "图边引用了不存在的节点。");
          return { from, to, label: text(edge?.label, `visuals[${index}].edges[${edgeIndex}].label`, 120, { optional: true }) };
        });
        const dataHash = hashObject({ nodes, edges });
        return { kind, title, alt, caption, claimIds, sourceArtifactIds: articleHash ? [articleHash] : [], dataHash, nodes, edges };
      }
      if (kind === "chart") {
        if (!Array.isArray(row.data) || row.data.length < 1 || row.data.length > MAX_POINTS) {
          throw new ApiError(502, "VISUAL_SPEC_INVALID", "图表必须提供 1–30 个数据点。");
        }
        const data = row.data.map((point, pointIndex) => ({
          label: boundedLabel(point?.label, `visuals[${index}].data[${pointIndex}].label`, 2, 14, 120),
          value: finite(point?.value, `visuals[${index}].data[${pointIndex}].value`),
        }));
        const dataHash = hashObject(data);
        return {
          kind,
          title,
          alt,
          caption,
          claimIds,
          sourceArtifactIds: articleHash ? [articleHash] : [],
          dataHash,
          chartType: row.chartType === "line" ? "line" : "bar",
          unit: text(row.unit ?? "", `visuals[${index}].unit`, 40, { optional: true }),
          data,
        };
      }
      if (!Array.isArray(row.items) || row.items.length < 2 || row.items.length > 12) {
        throw new ApiError(502, "VISUAL_SPEC_INVALID", "信息图必须提供 2–12 个信息项。");
      }
      return {
        kind,
        title,
        alt,
        caption,
        claimIds,
        sourceArtifactIds: articleHash ? [articleHash] : [],
        dataHash: hashObject(row.items),
        items: row.items.map((item, itemIndex) => ({
          label: boundedLabel(item?.label, `visuals[${index}].items[${itemIndex}].label`, 2, 16, 120),
          description: boundedLabel(item?.description, `visuals[${index}].items[${itemIndex}].description`, 5, 31, 500),
        })),
      };
    }),
  };
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function wrap(value, width) {
  const characters = [...String(value)];
  const lines = [];
  for (let index = 0; index < characters.length; index += width) lines.push(characters.slice(index, index + width).join(""));
  return lines.length ? lines : [""];
}

function svgText(value, x, y, { size = 18, weight = 500, fill = "#17202a", anchor = "middle", lineHeight } = {}) {
  return wrap(value, Math.max(6, Math.floor(700 / size)))
    .map((line, index) => `<text x="${x}" y="${y + index * (lineHeight ?? Math.round(size * 1.35))}" text-anchor="${anchor}" font-size="${size}" font-weight="${weight}" fill="${fill}" font-family="PingFang SC, Microsoft YaHei, Arial, sans-serif">${xml(line)}</text>`)
    .join("");
}

function graphSvg(spec) {
  const width = 1600;
  const columns = Math.min(4, Math.max(2, Math.ceil(Math.sqrt(spec.nodes.length))));
  const rows = Math.ceil(spec.nodes.length / columns);
  const nodeWidth = 290;
  const nodeHeight = 100;
  const gapX = 100;
  const gapY = 130;
  const left = (width - columns * nodeWidth - (columns - 1) * gapX) / 2;
  const top = 190;
  const height = top + rows * nodeHeight + Math.max(0, rows - 1) * gapY + 170;
  const positions = new Map(spec.nodes.map((node, index) => {
    const row = Math.floor(index / columns);
    const within = row % 2 === 0 ? index % columns : columns - 1 - (index % columns);
    return [node.id, { x: left + within * (nodeWidth + gapX), y: top + row * (nodeHeight + gapY) }];
  }));
  const nodeMarkup = spec.nodes.map((node, index) => {
    const position = positions.get(node.id);
    const fill = ["#eaf3ff", "#eafbf4", "#fff4df", "#f4ecff"][index % 4];
    const stroke = ["#276ef1", "#0b8f68", "#c77700", "#7c4dcc"][index % 4];
    return `<g><rect x="${position.x}" y="${position.y}" width="${nodeWidth}" height="${nodeHeight}" rx="18" fill="${fill}" stroke="${stroke}" stroke-width="3"/>${svgText(node.label, position.x + nodeWidth / 2, position.y + 42, { size: 19, weight: 650 })}${node.group ? `<text x="${position.x + nodeWidth / 2}" y="${position.y + 78}" text-anchor="middle" font-size="13" fill="#667085" font-family="PingFang SC, Arial, sans-serif">${xml(node.group)}</text>` : ""}</g>`;
  }).join("");
  const edgeMarkup = spec.edges.map(edge => {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    const x1 = from.x + nodeWidth / 2;
    const y1 = from.y + nodeHeight;
    const x2 = to.x + nodeWidth / 2;
    const y2 = to.y;
    const mid = (y1 + y2) / 2;
    const label = edge.label ? svgText(edge.label, (x1 + x2) / 2, mid - 8, { size: 13, fill: "#475467" }) : "";
    return `<path d="M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}" fill="none" stroke="#98a2b3" stroke-width="2.5" marker-end="url(#arrow)"/>${label}`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${xml(spec.alt)}"><rect width="100%" height="100%" fill="#ffffff"/><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#98a2b3"/></marker></defs>${svgText(spec.title, width / 2, 82, { size: 32, weight: 750 })}${spec.caption ? svgText(spec.caption, width / 2, 122, { size: 16, fill: "#667085" }) : ""}${edgeMarkup}${nodeMarkup}<text x="${width / 2}" y="${height - 42}" text-anchor="middle" font-size="12" fill="#98a2b3" font-family="Arial, sans-serif">Yao Ayi editable visual source</text></svg>`;
}

function chartSvg(spec) {
  const width = 1400;
  const height = 820;
  const maximum = Math.max(...spec.data.map(point => Math.abs(point.value)), 1);
  const left = 120;
  const chartWidth = width - 240;
  const chartHeight = 520;
  const step = chartWidth / spec.data.length;
  const elements = spec.chartType === "line"
    ? spec.data.map((point, index) => {
      const x = left + step * (index + 0.5);
      const y = 650 - (point.value - Math.min(0, ...spec.data.map(row => row.value))) /
        Math.max(1, maximum - Math.min(0, ...spec.data.map(row => row.value))) * chartHeight;
      return { x, y, point };
    }).map((row, index, rows) => {
      const next = rows[index + 1];
      return `<g>${next ? `<line x1="${row.x}" y1="${row.y}" x2="${next.x}" y2="${next.y}" stroke="#276ef1" stroke-width="5"/>` : ""}<circle cx="${row.x}" cy="${row.y}" r="9" fill="#276ef1" stroke="#fff" stroke-width="3"/>${svgText(row.point.label, row.x, 690, { size: 14 })}${svgText(`${row.point.value}${spec.unit}`, row.x, row.y - 18, { size: 14, weight: 650 })}</g>`;
    }).join("")
    : spec.data.map((point, index) => {
    const barHeight = Math.max(2, Math.abs(point.value) / maximum * chartHeight);
    const x = left + index * step + step * 0.16;
    const y = 650 - barHeight;
    return `<rect x="${x}" y="${y}" width="${step * 0.68}" height="${barHeight}" rx="10" fill="${["#276ef1", "#0b8f68", "#c77700", "#7c4dcc", "#db3a34"][index % 5]}"/>${svgText(point.label, x + step * 0.34, 690, { size: 14 })}${svgText(`${point.value}${spec.unit}`, x + step * 0.34, y - 16, { size: 14, weight: 650 })}`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${xml(spec.alt)}"><rect width="100%" height="100%" fill="#fff"/>${svgText(spec.title, width / 2, 78, { size: 32, weight: 750 })}${spec.caption ? svgText(spec.caption, width / 2, 118, { size: 16, fill: "#667085" }) : ""}<line x1="${left}" y1="650" x2="${left + chartWidth}" y2="650" stroke="#d0d5dd" stroke-width="2"/>${elements}</svg>`;
}

function infographicSvg(spec) {
  const width = 1200;
  const columns = spec.items.length <= 4 ? 2 : 3;
  const cardWidth = columns === 2 ? 500 : 330;
  const cardHeight = 190;
  const rows = Math.ceil(spec.items.length / columns);
  const gap = 32;
  const left = (width - columns * cardWidth - (columns - 1) * gap) / 2;
  const height = 220 + rows * cardHeight + Math.max(0, rows - 1) * gap + 80;
  const cards = spec.items.map((item, index) => {
    const row = Math.floor(index / columns);
    const x = left + (index % columns) * (cardWidth + gap);
    const y = 190 + row * (cardHeight + gap);
    return `<g><rect x="${x}" y="${y}" width="${cardWidth}" height="${cardHeight}" rx="24" fill="${index % 2 ? "#effaf6" : "#eef4ff"}" stroke="${index % 2 ? "#0b8f68" : "#276ef1"}" stroke-width="2"/>${svgText(item.label, x + cardWidth / 2, y + 55, { size: 22, weight: 750 })}${svgText(item.description, x + cardWidth / 2, y + 96, { size: 16, fill: "#475467" })}</g>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${xml(spec.alt)}"><rect width="100%" height="100%" fill="#fff"/>${svgText(spec.title, width / 2, 82, { size: 38, weight: 800 })}${spec.caption ? svgText(spec.caption, width / 2, 126, { size: 17, fill: "#667085" }) : ""}${cards}</svg>`;
}

export function renderVisualSvg(spec) {
  if (!spec || !VISUAL_KINDS.has(spec.kind)) throw new ApiError(502, "VISUAL_SPEC_INVALID", "无法渲染未知 VisualSpec。");
  const source = spec.kind === "chart" ? chartSvg(spec) : spec.kind === "infographic" ? infographicSvg(spec) : graphSvg(spec);
  return {
    bytes: Buffer.from(source, "utf8"),
    mime: "image/svg+xml",
    sha256: createHash("sha256").update(source).digest("hex"),
    specHash: hashObject(spec),
  };
}

export async function renderVisualPng(spec) {
  const svg = renderVisualSvg(spec);
  const bytes = await sharp(svg.bytes, { density: 144 }).png({ compressionLevel: 9 }).toBuffer();
  return {
    bytes,
    mime: "image/png",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    specHash: svg.specHash,
  };
}

export async function inspectRenderedVisual(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw new ApiError(415, "VISUAL_RENDER_INVALID", "渲染结果为空。");
  const metadata = await sharp(bytes).metadata();
  if (!metadata.format || !Number.isSafeInteger(metadata.width) || !Number.isSafeInteger(metadata.height) ||
      metadata.width < 1 || metadata.height < 1) {
    throw new ApiError(415, "VISUAL_RENDER_INVALID", "渲染结果没有可核对的宽高。");
  }
  return { format: metadata.format, width: metadata.width, height: metadata.height, bytes: bytes.length };
}

export function mermaidSource(spec) {
  if (spec.kind !== "architecture" && spec.kind !== "flow") return null;
  const lines = [spec.kind === "flow" ? "flowchart TD" : "flowchart LR"];
  for (const node of spec.nodes) lines.push(`  ${node.id}["${node.label.replaceAll('"', "'")}"]`);
  for (const edge of spec.edges) lines.push(`  ${edge.from} -->${edge.label ? `|${edge.label.replaceAll("|", "/")}|` : ""} ${edge.to}`);
  return lines.join("\n");
}
