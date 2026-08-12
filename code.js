const TOOL_ID = "91640e7c-3f87-49b0-824d-8b1f6e82acec"
const DISPLAY_NAME = "Documentation generator"
const ATTACH_KEY = TOOL_ID + ":state"
const DEFAULTS = {
  status: "Ready",
  dsLink: "",
  markdownDocs: "",
  generatedOverview: "",
  variantCols: 1
}
// Fixed icon node ID — always used for the header, no UI picker needed
const HEADER_ICON_NODE_ID = "297:10129"
let latestParams = DEFAULTS
let isExecuting = false

function normalizeParams(input) {
  const v = input ?? {}
  return {
    status: typeof v.status === "string" ? v.status : DEFAULTS.status,
    dsLink: typeof v.dsLink === "string" ? v.dsLink : DEFAULTS.dsLink,
    markdownDocs:
      typeof v.markdownDocs === "string"
        ? v.markdownDocs
        : DEFAULTS.markdownDocs,
    generatedOverview:
      typeof v.generatedOverview === "string"
        ? v.generatedOverview
        : DEFAULTS.generatedOverview,
    variantCols:
      typeof v.variantCols === "number"
        ? Math.max(1, Math.min(4, Math.round(v.variantCols)))
        : DEFAULTS.variantCols
  }
}

function htmlEsc(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
}

function uniqueSceneNodes(nodes) {
  return [...new Set(nodes)].filter(n => !n.removed)
}

function attachRelaunch(nodes) {
  const u = uniqueSceneNodes(nodes)
  if (u.length > 0)
    for (const n of u) n.setRelaunchData({ [TOOL_ID]: DISPLAY_NAME })
  else figma.root.setRelaunchData({ [TOOL_ID]: DISPLAY_NAME })
}

function singleSelectedTarget() {
  const s = figma.currentPage.selection
  return s.length === 1 ? s[0] ?? null : null
}

function readAttachment(node) {
  try {
    const p = JSON.parse(node.getPluginData(ATTACH_KEY))
    if (p?.version !== 1) return null
    return {
      version: 1,
      params: normalizeParams(p.params),
      state: p.state ?? null
    }
  } catch {
    return null
  }
}

function writeAttachment(node, params, state) {
  node.setPluginData(ATTACH_KEY, JSON.stringify({ version: 1, params, state }))
}

// ─────────────────────────────────────────────────────────────────────────────
// Markdown parser
// ─────────────────────────────────────────────────────────────────────────────
function mdSection(md, keys) {
  if (!md) return ""
  const lines = md.split("\n")
  for (const key of keys) {
    const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    let on = false
    let parentLevel = 1
    const out = []
    for (const line of lines) {
      const startMatch = line.match(new RegExp(`^(#+)\\s*${esc}\\s*$`, "i"))
      if (startMatch) {
        on = true
        parentLevel = startMatch[1].length
        continue
      }
      if (on) {
        // Only stop at headings of the SAME or HIGHER level (shallower depth),
        // not at sub-headings (deeper) like ### Do inside ## Usage.
        const hMatch = line.match(/^(#+)\s/)
        if (hMatch && hMatch[1].length <= parentLevel) break
        out.push(line)
      }
    }
    const r = out.join("\n").trim()
    if (r) return r
  }
  return ""
}

function mdBullets(md, keys) {
  const s = mdSection(md, keys)
  if (!s) return []
  return s
    .split("\n")
    .map(l => l.replace(/^[-*+]\s*/, "").trim())
    .filter(l => l.length > 0)
}

function _mdDosDonts(md) {
  const dos = mdBullets(md, ["Do", "Dos", "Do's", "Should", "Best practice"])
  const donts = mdBullets(md, [
    "Don't",
    "Donts",
    "Don'ts",
    "Avoid",
    "Do not",
    "Should not"
  ])
  const combined = mdSection(md, [
    "Dos and Don'ts",
    "Do's and Don'ts",
    "Do / Don't",
    "Do's & Don'ts"
  ])
  if (combined) {
    const lines = combined.split("\n")
    let inDo = false
    let inDont = false
    for (const line of lines) {
      if (line.match(/^#+\s*(do|dos|do's|should)\b/i)) {
        inDo = true
        inDont = false
        continue
      }
      if (line.match(/^#+\s*(don'?t|avoid|do not|should not)/i)) {
        inDont = true
        inDo = false
        continue
      }
      const b = line.match(/^[-*+]\s*(.+)/)
      if (b) {
        if (inDo && dos.length === 0) dos.push(b[1].trim())
        if (inDont && donts.length === 0) donts.push(b[1].trim())
      }
    }
  }
  return { dos, donts }
}

// ─────────────────────────────────────────────────────────────────────────────
// Component property helpers
// ─────────────────────────────────────────────────────────────────────────────
const APPEARANCE_PROP_RE = /^(appearance|type|style|kind|variant|color|mood|intent|tone|severity|state|level)$/i
const SIZE_PROP_RE = /^(size|scale|sizing|dimension|breakpoint|density)$/i
const THEME_PROP_RE = /^(theme|mode|color.?mode|scheme|colorscheme)$/i
const APPEARANCE_VAL_RE = /^(primary|secondary|tertiary|info|information|success|warning|error|danger|critical|neutral|default|brand|accent|positive|negative|destructive|subtle|ghost|outline|filled|light|dark|solid|soft|transparent)$/i
const SIZE_VAL_RE = /^(xs|sm|md|lg|xl|xxl|2xl|3xl|xsmall|small|medium|large|xlarge|xxlarge|tiny|compact|regular|base|full)$/i
// Theme value patterns: modern-light, modern-dark, legacy-light, legacy-dark etc.
const THEME_VAL_RE = /^(modern|legacy|light|dark)[-_](light|dark|modern|legacy)|^(modern|legacy)-(light|dark)$/i

function classifyProp(name, values) {
  if (SIZE_PROP_RE.test(name)) return "size"
  if (APPEARANCE_PROP_RE.test(name)) return "appearance"
  const sM = values.filter(v => SIZE_VAL_RE.test(v)).length
  const aM = values.filter(v => APPEARANCE_VAL_RE.test(v)).length
  if (sM >= 2 && sM >= values.length * 0.5) return "size"
  if (aM >= 2 && aM >= values.length * 0.5) return "appearance"
  return "variant"
}

function parseVariantName(name) {
  const r = {}
  name.split(",").forEach(p => {
    const kv = p.trim().split("=")
    if (kv.length === 2) r[kv[0].trim()] = kv[1].trim()
  })
  return r
}

// ─────────────────────────────────────────────────────────────────────────────
// Action
// ─────────────────────────────────────────────────────────────────────────────
function evaluateEnabled_generate(selection) {
  return selection.length === 1
}
function actionTarget_generate() {
  const t = singleSelectedTarget()
  if (t == null) return null
  return evaluateEnabled_generate([t]) ? t : null
}

async function action_generate(params, target, _prev) {
  const affectedNodes = [target]
  const selection = figma.currentPage.selection

  const sel = selection[0]
  if (!sel) {
    figma.notify("Select a component, component set, or instance first")
    return { affectedNodes, state: null }
  }

  // ── Resolve component ─────────────────────────────────────────────────────
  let mainComp = null
  let compSet = null

  if (sel.type === "INSTANCE") {
    mainComp = await sel.getMainComponentAsync()
    if (mainComp?.parent?.type === "COMPONENT_SET") compSet = mainComp.parent
  } else if (sel.type === "COMPONENT") {
    mainComp = sel
    if (mainComp.parent?.type === "COMPONENT_SET") compSet = mainComp.parent
  } else if (sel.type === "COMPONENT_SET") {
    compSet = sel
    mainComp = compSet.children[0] ?? null
  } else {
    figma.notify("Select a component, component set, or instance first")
    return { affectedNodes, state: null }
  }

  const displayName = compSet?.name ?? mainComp?.name ?? sel.name

  // ── Parse component properties ────────────────────────────────────────────
  const propMap = new Map()
  if (compSet) {
    for (const child of compSet.children) {
      if (child.type !== "COMPONENT") continue
      for (const [k, v] of Object.entries(parseVariantName(child.name))) {
        if (!propMap.has(k)) propMap.set(k, [])
        const a = propMap.get(k)
        if (!a.includes(v)) a.push(v)
      }
    }
  }

  // Values that indicate a VARIANT property is boolean-like
  const BOOL_VAL_RE = /^(true|false|yes|no|on|off|visible|hidden|enabled|disabled|show|hide)$/i
  function isBoolLike(values) {
    return values.length === 2 && values.every(v => BOOL_VAL_RE.test(v))
  }
  // Canonical "true" value for a boolean-like variant
  function boolTrueVal(values) {
    return (
      values.find(v => /^(true|yes|on|visible|enabled|show)$/i.test(v)) ??
      values[1] ??
      "true"
    )
  }
  function boolFalseVal(values) {
    return (
      values.find(v => /^(false|no|off|hidden|disabled|hide)$/i.test(v)) ??
      values[0] ??
      "false"
    )
  }

  const componentProps = new Map()
  const src = compSet ?? mainComp
  if (src && "componentPropertyDefinitions" in src) {
    for (const [rawKey, def] of Object.entries(
      src.componentPropertyDefinitions
    )) {
      // Strip everything from '#' onwards — handles formats like "showTitle#1212:0"
      const k = rawKey.split("#")[0].trim()
      if (def.type === "VARIANT") {
        const vals = def.variantOptions ?? propMap.get(k) ?? []
        // Treat VARIANT with only true/false-like values as BOOLEAN
        const effectiveType = isBoolLike(vals) ? "BOOLEAN" : "VARIANT"
        componentProps.set(k, {
          rawKey,
          type: effectiveType,
          values: vals,
          defaultValue: String(def.defaultValue)
        })
      } else if (def.type === "BOOLEAN") {
        componentProps.set(k, {
          rawKey,
          type: "BOOLEAN",
          values: ["false", "true"],
          defaultValue: String(def.defaultValue)
        })
      } else if (def.type === "TEXT") {
        componentProps.set(k, {
          rawKey,
          type: "TEXT",
          values: [],
          defaultValue: String(def.defaultValue)
        })
      }
    }
  }
  if (componentProps.size === 0) {
    for (const [k, vals] of propMap) {
      const effectiveType = isBoolLike(vals) ? "BOOLEAN" : "VARIANT"
      componentProps.set(k, {
        rawKey: k,
        type: effectiveType,
        values: vals,
        defaultValue: vals[0] ?? ""
      })
    }
  }

  const appearanceProps = []
  const sizeProps = []
  const booleanProps = []
  const otherProps = []
  for (const [name, data] of componentProps) {
    if (data.type === "BOOLEAN") booleanProps.push([name, data])
    else if (data.type === "VARIANT") {
      const cls = classifyProp(name, data.values)
      if (cls === "appearance") appearanceProps.push([name, data])
      else if (cls === "size") sizeProps.push([name, data])
      else otherProps.push([name, data])
    }
  }

  // ── Theme prop detection ──────────────────────────────────────────────────
  // A theme prop is a VARIANT whose name matches THEME_PROP_RE, or whose values
  // all match THEME_VAL_RE (e.g. modern-light / modern-dark / legacy-*).
  // Once identified, remove it from whichever bucket it landed in so it doesn't
  // appear twice (appearance is the likeliest bucket since "theme" was removed
  // from APPEARANCE_PROP_RE above, but guard the others too).
  const themeProps = []
  function isThemeProp(name, data) {
    if (data.type !== "VARIANT" || data.values.length < 2) return false
    if (THEME_PROP_RE.test(name)) return true
    return (
      data.values.length >= 2 && data.values.every(v => THEME_VAL_RE.test(v))
    )
  }
  function extractThemeFromBucket(bucket) {
    for (let i = bucket.length - 1; i >= 0; i--) {
      const [n, d] = bucket[i]
      if (isThemeProp(n, d)) {
        themeProps.push([n, d])
        bucket.splice(i, 1)
      }
    }
  }
  extractThemeFromBucket(appearanceProps)
  extractThemeFromBucket(sizeProps)
  extractThemeFromBucket(otherProps)

  // Convert kebab/snake values to Title Case: "modern-light" → "Modern Light"
  function formatThemeLabel(s) {
    return s
      .replace(/[-_]+/g, " ")
      .split(" ")
      .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(" ")
  }

  function findBestComponent(propName, propValue) {
    if (!compSet) return mainComp
    const cs = compSet.children.filter(
      c =>
        c.type === "COMPONENT" &&
        parseVariantName(c.name)[propName] === propValue
    )
    if (!cs.length) return null
    if (cs.length === 1) return cs[0]
    let best = cs[0]
    let score = -1
    for (const c of cs) {
      const p = parseVariantName(c.name)
      let s = 0
      for (const [kk, info] of componentProps) {
        if (kk === propName || info.type !== "VARIANT") continue
        if (p[kk] === info.values[0]) s++
      }
      if (s > score) {
        score = s
        best = c
      }
    }
    return best
  }

  let fontFamily = "Inter"
  for (const fam of ["Inter", "Roboto", "SF Pro Text", "Helvetica Neue"]) {
    try {
      await figma.loadFontAsync({ family: fam, style: "Regular" })
      fontFamily = fam
      break
    } catch {
      /* try next */
    }
  }
  async function lf(styles) {
    for (const s of styles) {
      try {
        await figma.loadFontAsync({ family: fontFamily, style: s })
        return { family: fontFamily, style: s }
      } catch {
        /* try next */
      }
    }
    return { family: fontFamily, style: "Regular" }
  }
  const fR = await lf(["Regular"])
  const fM = await lf(["Medium", "Regular"])
  const fB = await lf(["Bold", "ExtraBold", "Black"])
  const fSB = await lf(["SemiBold", "Semi Bold", "Medium", "Regular"])

  // ── Colors ────────────────────────────────────────────────────────────────
  const cBg = { r: 0.975, g: 0.975, b: 0.985 }
  const cSurf = { r: 1, g: 1, b: 1 }
  const cBorder = { r: 0.87, g: 0.87, b: 0.91 }
  const cText = { r: 0.08, g: 0.08, b: 0.1 }
  const cMuted = { r: 0.42, g: 0.42, b: 0.48 }
  const cSecBg = { r: 0.94, g: 0.94, b: 0.96 }
  const cPrev = { r: 0.96, g: 0.96, b: 0.985 }
  const cGreen = { r: 0.07, g: 0.53, b: 0.31 }
  const cRed = { r: 0.85, g: 0.19, b: 0.19 }
  const cBlue = { r: 0.09, g: 0.44, b: 0.97 }
  const STATUS_COLORS = {
    Draft: {
      bg: { r: 0.88, g: 0.88, b: 0.92 },
      text: { r: 0.35, g: 0.35, b: 0.42 }
    },
    "In Progress": {
      bg: { r: 1.0, g: 0.94, b: 0.8 },
      text: { r: 0.62, g: 0.43, b: 0.05 }
    },
    Ready: {
      bg: { r: 0.85, g: 0.96, b: 0.88 },
      text: { r: 0.08, g: 0.5, b: 0.28 }
    },
    Deprecated: {
      bg: { r: 1.0, g: 0.9, b: 0.82 },
      text: { r: 0.68, g: 0.3, b: 0.07 }
    },
    Archived: {
      bg: { r: 0.88, g: 0.88, b: 0.92 },
      text: { r: 0.35, g: 0.35, b: 0.42 }
    }
  }

  function sp(c, a = 1) {
    return { type: "SOLID", color: c, opacity: a }
  }

  // ── Layout helpers ────────────────────────────────────────────────────────
  //
  // KEY RULE: layoutSizingHorizontal = 'FILL' must be set AFTER appendChild.
  // All helpers return bare frames; callers use addFill / addHug to insert them.

  // Append child to parent AND immediately set FILL on the child.
  // This is the only safe way to use FILL.
  function addFill(parent, child) {
    parent.appendChild(child)
    child.layoutSizingHorizontal = "FILL"
  }

  // Append child normally (hug / fixed sizing, no fill).
  function add(parent, child) {
    parent.appendChild(child)
  }

  // VERTICAL auto-layout frame — height hugs, width unset (caller decides via addFill or add)
  function mkV(name, gap = 0) {
    const f = figma.createFrame()
    f.name = name
    f.fills = []
    f.layoutMode = "VERTICAL"
    f.primaryAxisSizingMode = "AUTO" // height hugs
    f.counterAxisSizingMode = "AUTO" // width hugs (overridden by addFill → FILL)
    f.itemSpacing = gap
    f.clipsContent = false
    return f
  }

  // HORIZONTAL auto-layout frame — both axes hug by default
  function mkH(name, gap = 0) {
    const f = figma.createFrame()
    f.name = name
    f.fills = []
    f.layoutMode = "HORIZONTAL"
    f.primaryAxisSizingMode = "AUTO" // width hugs
    f.counterAxisSizingMode = "AUTO" // height hugs
    f.itemSpacing = gap
    f.clipsContent = false
    return f
  }

  // Text — width hugs by default; caller uses addFill to make it fill-width + wrapping
  async function mkT(text, size, font, color) {
    const t = figma.createText()
    t.fontName = font
    t.fontSize = size
    t.fills = [sp(color)]
    t.characters = text || "—"
    // WIDTH_AND_HEIGHT = intrinsic; switch to HEIGHT (fill) only after addFill
    t.textAutoResize = "WIDTH_AND_HEIGHT"
    return t
  }

  // After adding a TextNode via addFill, call this to enable line-wrap
  function makeTextWrap(t) {
    t.textAutoResize = "HEIGHT" // wraps at the fill width, grows vertically
  }

  // Capitalize first letter of each word: "success" → "Success"
  function titleCase(s) {
    return s
      .split(/\s+/)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ")
  }

  // Chip — intrinsic size, never fill. fontSize optional (default 11 for small label chips).
  async function mkChip(text, bg, color, fontSize = 11) {
    const f = mkH("Chip", 0)
    f.fills = [sp(bg)]
    f.cornerRadius = 100
    f.paddingTop = 4
    f.paddingBottom = 4
    f.paddingLeft = 10
    f.paddingRight = 10
    const t = await mkT(text, fontSize, fM, color)
    add(f, t)
    return f
  }

  // Card — white bg + border, vertical, 20px padding, variable gap
  // Caller uses addFill to stretch card to parent width
  function mkCard(name, gap = 16, borderPaint) {
    const c = mkV(name, gap)
    c.fills = [sp(cSurf)]
    c.cornerRadius = 8
    c.paddingTop = 20
    c.paddingBottom = 20
    c.paddingLeft = 20
    c.paddingRight = 20
    c.strokes = [borderPaint ?? sp(cBorder)]
    c.strokeWeight = 1
    return c
  }

  // Example container — horizontal, fill parent width, hug height, gray bg
  // MUST be inserted via addFill so FILL is applied while inside a parent
  function mkExCont(name) {
    const f = mkH(name, 0)
    f.fills = [sp(cPrev)]
    f.cornerRadius = 8
    f.clipsContent = false
    f.paddingTop = 32
    f.paddingBottom = 32
    f.paddingLeft = 32
    f.paddingRight = 32
    f.primaryAxisAlignItems = "CENTER"
    f.counterAxisAlignItems = "CENTER"
    // counterAxisSizingMode = 'AUTO' → height hugs the instance
    f.counterAxisSizingMode = "AUTO"
    return f
  }

  // ── Root doc frame ────────────────────────────────────────────────────────
  const DOC_W = 1440
  const DOC_PAD = 64

  const doc = figma.createFrame()
  doc.name = `${displayName} Documentation`
  doc.fills = [sp(cBg)]
  doc.layoutMode = "VERTICAL"
  doc.resize(DOC_W, 100) // set width first; sizing modes below override height
  doc.primaryAxisSizingMode = "AUTO" // height hugs — must come AFTER resize()
  doc.counterAxisSizingMode = "AUTO" // width hugs content
  doc.minWidth = 2100
  doc.maxWidth = 2500
  doc.paddingTop = DOC_PAD
  doc.paddingBottom = DOC_PAD * 2
  doc.paddingLeft = DOC_PAD
  doc.paddingRight = DOC_PAD
  doc.itemSpacing = 48
  doc.clipsContent = false
  const vc = figma.viewport.center
  doc.x = vc.x - DOC_W / 2
  doc.y = vc.y - 500

  // Add child to doc with FILL width
  function docAdd(child) {
    doc.appendChild(child)
    child.layoutSizingHorizontal = "FILL"
  }

  // ── Section builder ───────────────────────────────────────────────────────
  async function mkSection(title) {
    const s = mkV(`Section: ${title}`, 28)
    // s will be docAdd-ed by caller; section header uses its own children
    const hdr = mkH(`${title} Header`, 14)
    hdr.counterAxisAlignItems = "CENTER"

    const bar = figma.createRectangle()
    bar.name = "Accent"
    bar.resize(4, 26)
    bar.fills = [sp(cBlue)]
    bar.cornerRadius = 2
    add(hdr, bar)

    const titleT = await mkT(title, 24, fB, cText)
    add(hdr, titleT)

    // hdr and bar are added to section s; hdr will be filled
    s.appendChild(hdr)
    hdr.layoutSizingHorizontal = "FILL"
    return s
  }

  const md = params.markdownDocs

  // ── HEADER ────────────────────────────────────────────────────────────────
  {
    const hdr = mkV("Header", 16)
    hdr.fills = [sp(cSurf)]
    hdr.cornerRadius = 12
    hdr.strokes = [sp(cBorder)]
    hdr.strokeWeight = 1
    hdr.paddingTop = 40
    hdr.paddingBottom = 40
    hdr.paddingLeft = 40
    hdr.paddingRight = 40

    // Title row: component name LEFT, status chip RIGHT (same horizontal line)
    const titleRow = mkH("Title Row", 16)
    titleRow.counterAxisAlignItems = "CENTER"
    const cTitle = { r: 0.29, g: 0.29, b: 0.29 } // #4A4A4A
    // Icon LEFT — added first so it appears before the title text
    try {
      const iconSrc = await figma.getNodeByIdAsync(HEADER_ICON_NODE_ID)
      if (iconSrc && iconSrc.type === "INSTANCE") {
        const iconMainComp = await iconSrc.getMainComponentAsync()
        if (iconMainComp) {
          const i = iconMainComp.createInstance()
          i.resize(43, 43)
          add(titleRow, i)
        }
      } else if (iconSrc && iconSrc.type === "COMPONENT") {
        const i = iconSrc.createInstance()
        i.resize(43, 43)
        add(titleRow, i)
      }
    } catch {
      /* icon not found — skip silently */
    }

    // Title text — fills remaining width after icon
    const titleT = await mkT(displayName, 45, fB, cTitle)
    add(titleRow, titleT)
    titleT.layoutSizingHorizontal = "FILL"
    titleT.textAutoResize = "HEIGHT"

    // Status chip RIGHT
    const sc = STATUS_COLORS[params.status] ?? STATUS_COLORS["Ready"]
    const statusChip = mkH("Status", 0)
    statusChip.fills = [sp(sc.bg)]
    statusChip.cornerRadius = 6
    statusChip.paddingTop = 15
    statusChip.paddingBottom = 15
    statusChip.paddingLeft = 15
    statusChip.paddingRight = 15
    const statusT = await mkT(params.status, 20, fM, sc.text)
    add(statusChip, statusT)
    add(titleRow, statusChip)

    addFill(hdr, titleRow)

    const descText = mdSection(md, ["Description", "About", "Summary"])
    if (descText) {
      const dt = await mkT(descText, 20, fR, { r: 0, g: 0, b: 0 })
      addFill(hdr, dt)
      makeTextWrap(dt)
    }

    // DS Link: padding 10px, original colors (background=cSecBg, text=cBlue)
    if (params.dsLink) {
      const linkChip = mkH("DS Link", 6)
      linkChip.fills = [sp(cSecBg)]
      linkChip.cornerRadius = 6
      linkChip.paddingTop = 10
      linkChip.paddingBottom = 10
      linkChip.paddingLeft = 10
      linkChip.paddingRight = 10
      const lt = await mkT("↗ View in Design System", 20, fM, cBlue)
      lt.hyperlink = { type: "URL", value: params.dsLink }
      add(linkChip, lt)
      add(hdr, linkChip)
    }

    if (params.dsLink) {
      const urlT = await mkT(params.dsLink, 16, fR, cMuted)
      addFill(hdr, urlT)
      makeTextWrap(urlT)
    }

    docAdd(hdr)
  }

  // ── USE CASES ─────────────────────────────────────────────────────────────
  // Extract ## Usage (or equivalent) then parse Do/Don't sub-headings from it.
  const usageText = mdSection(md, [
    "Usage",
    "Use Cases",
    "Use Case",
    "Guidelines",
    "Best Practices",
    "When to use"
  ])
  if (usageText) {
    const s = await mkSection("Use cases")

    // Intro text: lines before the first sub-heading inside ## Usage
    const introLines = []
    for (const line of usageText.split("\n")) {
      if (line.match(/^#+\s/)) break
      introLines.push(line)
    }
    const introText = introLines.join("\n").trim()

    // Do/Don't bullets from sub-headings inside ## Usage
    // (mdBullets treats usageText as a mini-markdown document)
    const dos = mdBullets(usageText, [
      "Do",
      "Dos",
      "Do's",
      "Should",
      "Best practice"
    ])
    const donts = mdBullets(usageText, [
      "Don't",
      "Donts",
      "Don'ts",
      "Avoid",
      "Do not",
      "Should not"
    ])

    // One combined card: intro text + Do/Don't row together
    if (introText || dos.length > 0 || donts.length > 0) {
      const card = mkCard("Usage Card", 20)

      if (introText) {
        await renderRichText(card, introText, 20)
      }

      if (dos.length > 0 || donts.length > 0) {
        const row = mkH("Do Don't Row", 20)
        row.counterAxisAlignItems = "MIN"

        if (dos.length > 0) {
          const doCard = mkCard("Do", 10, sp(cGreen, 0.4))
          const doHdr = mkH("Do Hdr", 6)
          doHdr.counterAxisAlignItems = "CENTER"
          const dm = await mkT("✔", 20, fB, cGreen)
          const dl = await mkT("Do", 20, fB, cGreen)
          add(doHdr, dm)
          add(doHdr, dl)
          add(doCard, doHdr)
          for (const item of dos.slice(0, 6)) {
            const ir = mkH("Do Item", 8)
            ir.counterAxisAlignItems = "MIN"
            const doIcon = await mkT("✔", 20, fR, cGreen)
            const doTxt = await mkT(item, 20, fR, cText)
            add(ir, doIcon)
            add(ir, doTxt)
            // Fixed 900px width; text fills remaining space and wraps
            ir.resize(900, 1)
            ir.primaryAxisSizingMode = "FIXED"
            ir.counterAxisSizingMode = "AUTO"
            doTxt.layoutSizingHorizontal = "FILL"
            doTxt.textAutoResize = "HEIGHT"
            add(doCard, ir)
          }
          row.appendChild(doCard)
          doCard.layoutSizingHorizontal = "FILL"
          doCard.layoutSizingVertical = "FILL"
        }

        if (donts.length > 0) {
          const dontCard = mkCard("Don't", 10, sp(cRed, 0.4))
          const dHdr = mkH("Don't Hdr", 6)
          dHdr.counterAxisAlignItems = "CENTER"
          const dm = await mkT("✘", 20, fB, cRed)
          const dl = await mkT("Don't", 20, fB, cRed)
          add(dHdr, dm)
          add(dHdr, dl)
          add(dontCard, dHdr)
          for (const item of donts.slice(0, 6)) {
            const ir = mkH("Dont Item", 8)
            ir.counterAxisAlignItems = "MIN"
            const dontIcon = await mkT("✘", 20, fR, cRed)
            const dontTxt = await mkT(item, 20, fR, cText)
            add(ir, dontIcon)
            add(ir, dontTxt)
            ir.resize(900, 1)
            ir.primaryAxisSizingMode = "FIXED"
            ir.counterAxisSizingMode = "AUTO"
            dontTxt.layoutSizingHorizontal = "FILL"
            dontTxt.textAutoResize = "HEIGHT"
            add(dontCard, ir)
          }
          row.appendChild(dontCard)
          dontCard.layoutSizingHorizontal = "FILL"
          dontCard.layoutSizingVertical = "FILL"
        }

        addFill(card, row)
      }

      addFill(s, card)
    } else if (!introText) {
      // No sub-headings and no intro — render with bullet detection
      const card = mkCard("Use Cases Card")
      await renderRichText(card, usageText, 20)
      addFill(s, card)
    }

    docAdd(s)
  }

  // ── Shared rich-text renderer ─────────────────────────────────────────────
  // Lines starting with "- " / "* " / "+ " → "→" arrow row (same as Tips).
  // All other lines accumulate as plain paragraphs.
  async function renderRichText(container, text, fontSize = 13) {
    let paraAcc = []
    const flushPara = async () => {
      const t = paraAcc.join("\n").trim()
      if (t) {
        const p = await mkT(t, fontSize, fR, cText)
        addFill(container, p)
        makeTextWrap(p)
      }
      paraAcc = []
    }
    for (const line of text.split("\n")) {
      const bm = line.match(/^[-*+]\s+(.+)/)
      if (bm) {
        await flushPara()
        const ir = mkH("Item", 10)
        ir.counterAxisAlignItems = "MIN"
        add(ir, await mkT("→", fontSize, fM, cBlue))
        const bt = await mkT(bm[1].trim(), fontSize, fR, cText)
        add(ir, bt)
        addFill(container, ir)
      } else {
        paraAcc.push(line)
      }
    }
    await flushPara()
  }

  // ── TIPS ──────────────────────────────────────────────────────────────────
  const tipsText = mdSection(md, ["Tips", "Tip", "Notes", "Hints", "Pro tips"])
  if (tipsText) {
    const s = await mkSection("Tips")
    const card = mkCard("Tips Card")
    const bullets = tipsText
      .split("\n")
      .map(l => l.replace(/^[-*+]\s*/, "").trim())
      .filter(l => l.length > 0)
    if (bullets.length > 1) {
      for (const b of bullets) {
        const ir = mkH("Tip Item", 10)
        ir.counterAxisAlignItems = "MIN"
        const arrow = await mkT("→", 20, fM, cBlue)
        const txt = await mkT(b, 20, fR, cText)
        add(ir, arrow)
        add(ir, txt)
        txt.layoutSizingHorizontal = "FILL"
        txt.textAutoResize = "HEIGHT"
        txt.lineHeight = { value: 150, unit: "PERCENT" }
        addFill(card, ir)
      }
    } else {
      const tt = await mkT(tipsText, 20, fR, cText)
      addFill(card, tt)
      makeTextWrap(tt)
    }
    addFill(s, card)
    docAdd(s)
  }

  // ── Variant description from markdown ─────────────────────────────────────
  // Searches the Markdown for a sub-heading matching `value` inside any of the
  // candidate parent sections, then returns its body text.
  // Returns '' when no description is found — callers skip rendering in that case.
  function findVariantDesc(propName, value) {
    // Candidate parent sections to search inside (broader list)
    const parentKeys = [
      propName,
      propName + "s",
      "Variants",
      "Variant",
      "Types",
      "Type",
      "Appearances",
      "Appearance",
      "Sizes",
      "Size",
      "States",
      "State",
      "Styles",
      "Style"
    ]
    const esc = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const subRe = new RegExp(`^#+\\s*${esc}\\s*$`, "i")

    // 1. Try inside parent sections
    for (const key of parentKeys) {
      const sc = mdSection(md, [key])
      if (!sc) continue
      const lines = sc.split("\n")
      let found = false
      const out = []
      for (const line of lines) {
        if (line.match(subRe)) {
          found = true
          continue
        }
        if (found && line.match(/^#+\s/)) break
        if (found && line.trim()) out.push(line.trim())
      }
      const result = out.join(" ").trim()
      if (result) return result
    }

    // 2. Try the value as a top-level section in the whole document
    const topLevel = mdSection(md, [value])
    if (topLevel) return topLevel

    return ""
  }

  // ── Helper: build variant section ─────────────────────────────────────────
  async function addVariantSection(sectionTitle, entries, cols = 1) {
    if (!entries.length) return
    const s = await mkSection(sectionTitle)
    const cards = []
    const exConts = [] // track all Example containers for height equalization

    for (const [propName, propData] of entries) {
      for (const value of propData.values) {
        const card = mkCard(`${value} Card`, 12)

        // Variant title — capitalized, 20px
        const titleT = await mkT(titleCase(value), 20, fSB, cText)
        addFill(card, titleT)
        makeTextWrap(titleT)

        // Markdown description — only rendered when found
        const desc = findVariantDesc(propName, value)
        if (desc) {
          const dt = await mkT(desc, 16, fR, cText)
          addFill(card, dt)
          makeTextWrap(dt)
        }

        const exCont = mkExCont("Example")
        const instWrapper = mkH("Instance Wrapper", 0)
        // Always use mainComp as the base so default boolean properties (showTitle etc.)
        // are preserved. Only change the target variant property via rawKey.
        if (mainComp) {
          const inst = mainComp.createInstance()
          const rawKey = componentProps.get(propName)?.rawKey ?? propName
          try {
            inst.setProperties({ [rawKey]: value })
          } catch {
            /* ignore */
          }
          add(instWrapper, inst)
        }
        add(exCont, instWrapper)
        addFill(card, exCont)
        exConts.push(exCont)
        cards.push(card)
      }
    }
    addFill(s, buildGridList(`${sectionTitle} List`, cards, cols))
    docAdd(s)

    // After docAdd, Figma has computed all rendered dimensions.
    // Fix every Example container to the tallest one's height so they align.
    if (exConts.length > 1) {
      const maxExH = Math.max(...exConts.map(e => e.height))
      if (maxExH > 0) {
        for (const e of exConts) {
          // For a HORIZONTAL frame, counterAxis = height. Fix it.
          e.counterAxisSizingMode = "FIXED"
          e.resize(e.width, maxExH)
        }
      }
    }
  }

  // ── 2-column grid helpers ────────────────────────────────────────────────
  // Column count based on max instance width measured from component nodes.
  // Uses component node .width directly — no instance creation needed.
  function layoutColumns(maxInstW) {
    return maxInstW > 600 ? 1 : 2
  }

  // Max component width across a set of variant entries
  function maxCompWidth(entries) {
    let w = 0
    for (const [propName, propData] of entries) {
      for (const value of propData.values) {
        const c = findBestComponent(propName, value) ?? mainComp
        if (c) w = Math.max(w, c.width)
      }
    }
    return w
  }

  // Wrap cards into a vertical list with N equal-width columns.
  // cols=1 → full-width stack; cols>1 → N-column rows with height equalization.
  function buildGridList(name, cards, cols = 2) {
    const n = Math.max(1, Math.round(cols))
    const list = mkV(name, 20)
    if (n === 1) {
      for (const card of cards) addFill(list, card)
      return list
    }
    for (let i = 0; i < cards.length; i += n) {
      const rowCards = cards.slice(i, i + n)
      if (rowCards.length === 1) {
        addFill(list, rowCards[0])
      } else {
        const row = mkH(`${name} Row`, 24)
        row.counterAxisAlignItems = "MIN"
        for (const c of rowCards) {
          row.appendChild(c)
          c.layoutSizingHorizontal = "FILL"
        }
        // Tallest card stays HUG — drives row height.
        // Shorter cards get layoutSizingVertical = 'FILL' so they expand to match
        // without any FIXED sizing.
        const maxH = Math.max(...rowCards.map(c => c.height))
        if (maxH > 0) {
          for (const c of rowCards) {
            if (c.height < maxH) {
              c.layoutSizingVertical = "FILL"
            }
          }
        }
        addFill(list, row)
      }
    }
    return list
  }

  // Variant grid section: each value = one card (title + desc + example), 2-col layout
  async function addVariantGridSection(
    sectionTitle,
    entries,
    showDimensions = false,
    titleFormatter
  ) {
    if (!entries.length) return
    const s = await mkSection(sectionTitle)
    const cols = layoutColumns(maxCompWidth(entries))
    const cards = []
    const exConts = []

    for (const [propName, propData] of entries) {
      for (const value of propData.values) {
        const displayTitle = titleFormatter ? titleFormatter(value) : value
        const card = mkCard(`${displayTitle} Card`, 12)

        const titleT = await mkT(titleCase(displayTitle), 20, fSB, cText)
        addFill(card, titleT)
        makeTextWrap(titleT)

        const desc = findVariantDesc(propName, value)
        if (desc) {
          const dt = await mkT(desc, 16, fR, cText)
          addFill(card, dt)
          makeTextWrap(dt)
        }

        // Always use mainComp as base — preserves default booleans (showTitle etc.)
        let inst = null
        if (mainComp) {
          inst = mainComp.createInstance()
          const rawKey = componentProps.get(propName)?.rawKey ?? propName
          try {
            inst.setProperties({ [rawKey]: value })
          } catch {
            /* ignore */
          }
        }

        if (showDimensions && inst) {
          const dimT = await mkT(
            `W: ${Math.round(inst.width)}px  •  H: ${Math.round(
              inst.height
            )}px`,
            16,
            fR,
            cMuted
          )
          addFill(card, dimT)
          makeTextWrap(dimT)
        }

        const exCont = mkExCont("Example")
        const instWrapper = mkH("Instance Wrapper", 0)
        if (inst) add(instWrapper, inst)
        add(exCont, instWrapper)
        addFill(card, exCont)
        exConts.push(exCont)
        cards.push(card)
      }
    }

    addFill(s, buildGridList(`${sectionTitle} Grid`, cards, cols))
    docAdd(s)

    // Equalize Example container heights across all cards in section
    if (exConts.length > 1) {
      const maxExH = Math.max(...exConts.map(e => e.height))
      if (maxExH > 0) {
        for (const e of exConts) {
          e.counterAxisSizingMode = "FIXED"
          e.resize(e.width, maxExH)
        }
      }
    }
  }

  // Boolean card builder.
  // stackExamples=false (default) → OFF | ON side-by-side for compact components.
  // stackExamples=true → OFF then ON stacked vertically for wide components (> 600px).
  async function buildBoolCard(propName, propData, stackExamples = false) {
    const collectedExConts = []
    const card = mkCard(`${propName} Card`, 14)

    const nameT = await mkT(titleCase(propName), 20, fSB, cText)
    addFill(card, nameT)
    makeTextWrap(nameT)

    const bDesc = mdSection(md, [propName])
    if (bDesc) {
      const dt = await mkT(bDesc, 16, fR, cMuted)
      addFill(card, dt)
      makeTextWrap(dt)
    }

    const isVariantBool =
      propData.type === "BOOLEAN" &&
      propData.values.length === 2 &&
      propData.values.some(v => /^(true|false)$/i.test(v) === false)
    const offVal = isVariantBool ? boolFalseVal(propData.values) : false
    const onVal = isVariantBool ? boolTrueVal(propData.values) : true

    if (stackExamples) {
      // Vertical stack: OFF then ON, each full-width
      for (const [label, propVal] of [
        ["OFF", offVal],
        ["ON", onVal]
      ]) {
        const isOn = label === "ON"
        const col = mkV(`${label} Col`, 8)

        const chipBg = isOn ? { r: 0.85, g: 0.96, b: 0.88 } : cSecBg
        const chipTxt = isOn ? cGreen : cMuted
        const cRow = mkH("Chip Row", 0)
        add(cRow, await mkChip(label, chipBg, chipTxt))
        add(col, cRow)

        const exCont = mkExCont(`${label} Example`)
        const instWrapper = mkH("Instance Wrapper", 0)
        if (mainComp) {
          const inst = mainComp.createInstance()
          try {
            inst.setProperties({ [propData.rawKey]: propVal })
          } catch {
            /* ignore */
          }
          add(instWrapper, inst)
        }
        add(exCont, instWrapper)
        addFill(col, exCont)
        addFill(card, col)
        collectedExConts.push(exCont)
      }
    } else {
      // Side-by-side: OFF | ON
      const exRow = mkH("Example Row", 16)
      exRow.counterAxisAlignItems = "MIN"

      for (const [label, propVal] of [
        ["OFF", offVal],
        ["ON", onVal]
      ]) {
        const isOn = label === "ON"
        const col = mkV(`${label} Col`, 8)

        const chipBg = isOn ? { r: 0.85, g: 0.96, b: 0.88 } : cSecBg
        const chipTxt = isOn ? cGreen : cMuted
        const cRow = mkH("Chip Row", 0)
        add(cRow, await mkChip(label, chipBg, chipTxt))
        add(col, cRow)

        const exCont = mkExCont(`${label} Example`)
        const instWrapper = mkH("Instance Wrapper", 0)
        if (mainComp) {
          const inst = mainComp.createInstance()
          try {
            inst.setProperties({ [propData.rawKey]: propVal })
          } catch {
            /* ignore */
          }
          add(instWrapper, inst)
        }
        add(exCont, instWrapper)
        addFill(col, exCont)
        collectedExConts.push(exCont)

        exRow.appendChild(col)
        col.layoutSizingHorizontal = "FILL"
      }
      addFill(card, exRow)
    }

    return { card, exConts: collectedExConts }
  }

  // ── VARIANTS (appearance props) ───────────────────────────────────────────
  await addVariantSection("Variants", appearanceProps, params.variantCols)

  // ── OTHER VARIANT PROPS — 2-column grid ───────────────────────────────────
  if (otherProps.length > 0) {
    // Group all other variant props into one section if they share no clear theme,
    // or render each as its own grid section
    for (const [pn, pd] of otherProps) {
      if (pd.values.length > 0) await addVariantGridSection(pn, [[pn, pd]])
    }
  }

  // ── SIZES — 2-column grid with dimensions ─────────────────────────────────
  await addVariantGridSection("Sizes", sizeProps, true)

  // ── BOOLEAN VARIANTS — single column ──────────────────────────────────────
  if (booleanProps.length > 0) {
    const s = await mkSection("Boolean variants")
    const list = mkV("Boolean List", 20)
    const boolStack = layoutColumns(mainComp?.width ?? 0) === 1
    const allBoolExConts = []
    for (const [propName, propData] of booleanProps) {
      const { card, exConts: bec } = await buildBoolCard(
        propName,
        propData,
        boolStack
      )
      addFill(list, card)
      for (const e of bec) allBoolExConts.push(e)
    }
    addFill(s, list)
    docAdd(s)

    // Equalize all Example container heights across the entire Boolean section
    if (allBoolExConts.length > 1) {
      const maxExH = Math.max(...allBoolExConts.map(e => e.height))
      if (maxExH > 0) {
        for (const e of allBoolExConts) {
          e.counterAxisSizingMode = "FIXED"
          e.resize(e.width, maxExH)
        }
      }
    }
  }

  let themeGridNaturalW = 0 // set after themes section is built; used for doc resize

  // ── THEMES ────────────────────────────────────────────────────────────────
  // Three-strategy component-first detection.
  {
    const varThemes = []
    const auditLog = ["=== Themes Audit ==="]
    const THEME_MODE_RE = /\b(modern|legacy|light|dark)\b/i

    function themeHits(col) {
      return col.modes
        .filter(m => THEME_MODE_RE.test(m.name))
        .map(m => ({ modeId: m.modeId, modeName: m.name }))
    }
    function addToVarThemes(col, source) {
      const hits = themeHits(col)
      if (hits.length >= 2) {
        for (const h of hits)
          varThemes.push({ col, modeId: h.modeId, modeName: h.modeName })
        auditLog.push(
          `  → "${col.name}" (${source}): ${hits
            .map(h => h.modeName)
            .join(", ")}`
        )
      }
    }

    // ── Strategy A: resolvedVariableModes on the component node ──────────────
    // getVariableCollectionByIdAsync works for remote collections the file
    // already references through an enabled library.
    auditLog.push("Strategy A: resolvedVariableModes on component")
    try {
      const srcNode =
        compSet ?? mainComp ?? (sel.type !== "COMPONENT_SET" ? sel : null)
      const modesMap = srcNode?.resolvedVariableModes ?? {}
      const collectionIds = Object.keys(modesMap)
      auditLog.push(
        `  resolvedVariableModes: ${collectionIds.length} collection(s)`
      )
      for (const colId of collectionIds) {
        const col = await figma.variables.getVariableCollectionByIdAsync(colId)
        if (col) {
          auditLog.push(
            `  collection "${col.name}" (${
              col.remote ? "remote" : "local"
            }): modes=[${col.modes.map(m => m.name).join(", ")}]`
          )
          addToVarThemes(col, "resolvedVariableModes")
        } else {
          auditLog.push(`  collectionId ${colId} → null (not accessible)`)
        }
      }
    } catch (e) {
      auditLog.push(
        `  Strategy A error: ${e instanceof Error ? e.message : String(e)}`
      )
    }
    auditLog.push(`  After A: ${varThemes.length} theme mode(s)`)

    // ── Strategy B: getLocalVariableCollectionsAsync (local + imported remote) ─
    if (varThemes.length < 2) {
      auditLog.push("Strategy B: getLocalVariableCollectionsAsync")
      try {
        const localCols = await figma.variables.getLocalVariableCollectionsAsync()
        auditLog.push(`  ${localCols.length} collection(s) found`)
        for (const col of localCols) {
          auditLog.push(
            `  "${col.name}" (${
              col.remote ? "remote" : "local"
            }): [${col.modes.map(m => m.name).join(", ")}]`
          )
          addToVarThemes(col, "local/imported")
        }
      } catch (e) {
        auditLog.push(
          `  Strategy B error: ${e instanceof Error ? e.message : String(e)}`
        )
      }
      auditLog.push(`  After B: ${varThemes.length} theme mode(s)`)
    }

    // ── Strategy C: teamLibrary — import one variable per collection ──────────
    if (varThemes.length < 2) {
      auditLog.push(
        "Strategy C: teamLibrary.getAvailableLibraryVariableCollectionsAsync"
      )
      try {
        const libCols = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync()
        auditLog.push(`  ${libCols.length} library collection(s)`)
        for (const libCol of libCols) {
          if (varThemes.length >= 2) break
          auditLog.push(`  checking "${libCol.name}" (${libCol.libraryName})`)
          try {
            const libVars = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(
              libCol.key
            )
            if (libVars.length > 0) {
              const imported = await figma.variables.importVariableByKeyAsync(
                libVars[0].key
              )
              const col = await figma.variables.getVariableCollectionByIdAsync(
                imported.variableCollectionId
              )
              if (col) {
                auditLog.push(
                  `    imported → "${col.name}": [${col.modes
                    .map(m => m.name)
                    .join(", ")}]`
                )
                addToVarThemes(col, "teamLibrary import")
              }
            }
          } catch (importErr) {
            auditLog.push(
              `    import error: ${
                importErr instanceof Error
                  ? importErr.message
                  : String(importErr)
              }`
            )
          }
        }
      } catch (e) {
        auditLog.push(
          `  Strategy C error: ${e instanceof Error ? e.message : String(e)}`
        )
      }
      auditLog.push(`  After C: ${varThemes.length} theme mode(s)`)
    }

    // Cache variable lookups to avoid repeated async calls
    const varCache = new Map()
    async function getVar(id) {
      if (varCache.has(id)) return varCache.get(id)
      try {
        const v = await figma.variables.getVariableByIdAsync(id)
        varCache.set(id, v)
        return v
      } catch {
        varCache.set(id, null)
        return null
      }
    }

    function isRGBA(v) {
      return (
        typeof v === "object" && v !== null && "r" in v && "g" in v && "b" in v
      )
    }
    function isVarAlias(v) {
      return typeof v === "object" && v !== null && v.type === "VARIABLE_ALIAS"
    }

    // Resolve a variable to its final color value using resolveForConsumer
    // which respects the consumer node's applied variable modes.
    async function resolveColorVar(varId, consumer) {
      const variable = await getVar(varId)
      if (!variable || variable.resolvedType !== "COLOR") return null
      try {
        const resolved = variable.resolveForConsumer(consumer)
        if (resolved.resolvedType === "COLOR" && isRGBA(resolved.value))
          return resolved.value
        if (isVarAlias(resolved.value))
          return resolveColorVar(resolved.value.id, consumer)
      } catch {
        /* unresolvable */
      }
      return null
    }

    // Walk the full subtree of an instance and collect unique color variable bindings.
    // Uses resolveForConsumer so values reflect the active theme mode.
    async function extractColorTokens(inst) {
      const seen = new Set()
      const tokens = []

      async function addToken(vid) {
        if (seen.has(vid)) return
        seen.add(vid)
        const color = await resolveColorVar(vid, inst)
        if (color) {
          const v = await getVar(vid)
          const rawName = v?.name ?? vid
          const name = rawName.split("/").pop() ?? rawName
          tokens.push({ varId: vid, name, color })
        }
      }

      async function visit(node, depth) {
        if (depth > 12) return

        // Fills and strokes carry color variables via SolidPaint.boundVariables.color
        for (const paintArray of ["fills", "strokes"]) {
          if (!(paintArray in node)) continue
          const paints = node[paintArray]
          if (!Array.isArray(paints)) continue
          for (const paint of paints) {
            if (paint.type !== "SOLID") continue
            const bv = paint.boundVariables
            const alias = bv?.color
            if (alias && alias.type === "VARIABLE_ALIAS") {
              await addToken(alias.id)
            }
          }
        }

        // Check node-level boundVariables (fills, strokes, effects)
        try {
          const nbv = node.boundVariables
          if (nbv) {
            for (const key of Object.keys(nbv)) {
              const binding = nbv[key]
              if (Array.isArray(binding)) {
                for (const b of binding) {
                  if (b && b.type === "VARIABLE_ALIAS") await addToken(b.id)
                }
              } else if (binding && binding.type === "VARIABLE_ALIAS") {
                const v = await getVar(binding.id)
                if (v && v.resolvedType === "COLOR") await addToken(binding.id)
              }
            }
          }
        } catch {
          /* skip */
        }

        // Check effects (shadows, glows) for color variable bindings
        if ("effects" in node) {
          const effects = node.effects
          if (Array.isArray(effects)) {
            for (const eff of effects) {
              const ebv = eff.boundVariables
              if (ebv?.color && ebv.color.type === "VARIABLE_ALIAS") {
                await addToken(ebv.color.id)
              }
            }
          }
        }

        // Recurse into children
        if ("children" in node) {
          for (const child of node.children) {
            await visit(child, depth + 1)
          }
        }
      }

      await visit(inst, 0)

      // Sort: background > border > text > icon > other
      function tokenPriority(name) {
        const n = name.toLowerCase()
        if (/background|bg|surface|container|fill/.test(n)) return 1
        if (/border|stroke|outline|divider/.test(n)) return 2
        if (/text|label|content|fg|foreground|on-/.test(n)) return 3
        if (/icon|symbol|graphic/.test(n)) return 4
        return 5
      }
      tokens.sort((a, b) => tokenPriority(a.name) - tokenPriority(b.name))
      return tokens
    }

    function colorToHex(c) {
      const h = v =>
        Math.round(v * 255)
          .toString(16)
          .padStart(2, "0")
          .toUpperCase()
      const base = `#${h(c.r)}${h(c.g)}${h(c.b)}`
      return c.a !== undefined && c.a < 0.999 ? base + h(c.a) : base
    }

    // Fallback: extract unique hardcoded colors when no variable tokens are found
    function extractHardcodedColors(inst) {
      const seen = new Set()
      const tokens = []

      function visitHardcoded(node, depth) {
        if (depth > 12) return

        for (const paintArray of ["fills", "strokes"]) {
          if (!(paintArray in node)) continue
          const paints = node[paintArray]
          if (!Array.isArray(paints)) continue
          for (const paint of paints) {
            if (paint.type !== "SOLID") continue
            if (paint.visible === false) continue
            const c = paint.color
            const opacity = paint.opacity ?? 1
            if (opacity < 0.01) continue
            const hex = colorToHex({ r: c.r, g: c.g, b: c.b, a: opacity })
            if (seen.has(hex)) continue
            seen.add(hex)
            tokens.push({
              varId: hex,
              name: hex,
              color: { r: c.r, g: c.g, b: c.b, a: opacity }
            })
          }
        }

        if ("children" in node) {
          for (const child of node.children) {
            visitHardcoded(child, depth + 1)
          }
        }
      }

      visitHardcoded(inst, 0)
      return tokens
    }

    // Render a token list below an example container
    async function renderTokenList(parent, tokens, textCol, mutedCol) {
      if (tokens.length === 0) return
      const list = mkV("Token List", 6)
      list.fills = []
      for (const tok of tokens) {
        const row = mkH("Token Row", 6)
        row.fills = []
        row.counterAxisAlignItems = "CENTER"

        // Color swatch (12×12 filled ellipse)
        const swatch = figma.createEllipse()
        swatch.name = "Swatch"
        swatch.resize(12, 12)
        swatch.fills = [
          {
            type: "SOLID",
            color: { r: tok.color.r, g: tok.color.g, b: tok.color.b },
            opacity: tok.color.a ?? 1
          }
        ]
        swatch.strokes = [
          { type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: 0.12 }
        ]
        swatch.strokeWeight = 0.5
        add(row, swatch)

        // Token name
        const nameT = figma.createText()
        await figma.loadFontAsync(fM)
        nameT.fontName = fM
        nameT.fontSize = 11
        nameT.fills = [sp(textCol)]
        nameT.characters = tok.name
        nameT.textAutoResize = "WIDTH_AND_HEIGHT"
        add(row, nameT)

        // Hex value
        const hexT = figma.createText()
        await figma.loadFontAsync(fR)
        hexT.fontName = fR
        hexT.fontSize = 11
        hexT.fills = [sp(mutedCol)]
        hexT.characters = colorToHex(tok.color)
        hexT.textAutoResize = "WIDTH_AND_HEIGHT"
        add(row, hexT)

        add(list, row)
      }
      add(parent, list)
    }

    // ── Build section: horizontal comparison layout ───────────────────────────
    const dedupedThemes = varThemes.filter(
      (t, i, arr) =>
        arr.findIndex(x => x.modeId === t.modeId && x.col.id === t.col.id) === i
    )

    if (dedupedThemes.length >= 2) {
      const s = await mkSection("Themes")

      // Palette for dark and light columns
      const cDarkColBg = { r: 0.08, g: 0.08, b: 0.1 }
      const cDarkBorder = { r: 0.18, g: 0.18, b: 0.22 }
      const cDarkText = { r: 0.94, g: 0.94, b: 0.97 }
      const cDarkMuted = { r: 0.6, g: 0.6, b: 0.68 }
      const cDarkExBg = { r: 0.12, g: 0.12, b: 0.16 }
      const cLightColBg = { r: 1, g: 1, b: 1 }
      const cLightBorder = cBorder

      function isDark(modeName) {
        return /dark/i.test(modeName)
      }

      // Horizontal grid: one column per theme, all equal width
      const themesGrid = mkH("Themes Grid", 20)
      themesGrid.counterAxisAlignItems = "MIN"

      for (const vt of dedupedThemes) {
        const dark = isDark(vt.modeName)
        const colBg = dark ? cDarkColBg : cLightColBg
        const colBorder = dark ? cDarkBorder : cLightBorder
        const titleCol = dark ? cDarkText : cText
        const varTxtCol = dark ? cDarkMuted : cMuted
        const exBg = dark ? cDarkExBg : cPrev

        // Column frame
        const col = mkV(`${vt.modeName} Col`, 20)
        col.fills = [sp(colBg)]
        col.cornerRadius = 12
        col.strokes = [sp(colBorder)]
        col.strokeWeight = 1
        col.paddingTop = 20
        col.paddingBottom = 20
        col.paddingLeft = 20
        col.paddingRight = 20
        col.clipsContent = false

        // Column header: theme label — use hug text (col itself is HUG; FILL text → 0 width)
        const colTitle = await mkT(
          formatThemeLabel(vt.modeName),
          20,
          fSB,
          titleCol
        )
        // textAutoResize stays WIDTH_AND_HEIGHT (set by mkT) — text hugs its content
        add(col, colTitle)

        // Thin separator — fixed intrinsic width, no FILL
        const sep = figma.createRectangle()
        sep.name = "Sep"
        sep.resize(40, 1)
        sep.fills = [sp(dark ? cDarkBorder : cBorder)]
        add(col, sep)

        if (appearanceProps.length > 0) {
          // One block per appearance variant, stacked vertically in the column
          for (const [propName, propData] of appearanceProps) {
            for (const value of propData.values) {
              const varBlock = mkV(`${value} Block`, 8)
              varBlock.fills = []

              // Variant name — hug text, no FILL (col is HUG)
              const vt2 = await mkT(value, 16, fSB, varTxtCol)
              add(varBlock, vt2)

              // Example container — hugs instance (HUG from mkH + no addFill)
              const exCont = mkH(`${value} Ex`, 0)
              exCont.fills = [sp(exBg)]
              exCont.cornerRadius = 8
              exCont.paddingTop = 20
              exCont.paddingBottom = 20
              exCont.paddingLeft = 20
              exCont.paddingRight = 20
              exCont.primaryAxisAlignItems = "CENTER"
              exCont.counterAxisAlignItems = "CENTER"
              exCont.clipsContent = false

              let themeInst = null
              const comp = findBestComponent(propName, value) ?? mainComp
              if (comp) {
                try {
                  const inst = comp.createInstance()
                  inst.setExplicitVariableModeForCollection(vt.col, vt.modeId)
                  themeInst = inst
                  const rawKey =
                    componentProps.get(propName)?.rawKey ?? propName
                  try {
                    inst.setProperties({ [rawKey]: value })
                  } catch {
                    /* ignore */
                  }
                  const iw = mkH("IW", 0)
                  add(iw, inst)
                  add(exCont, iw)
                } catch (e) {
                  const et = await mkT(
                    `Error: ${e instanceof Error ? e.message : String(e)}`,
                    11,
                    fR,
                    varTxtCol
                  )
                  add(exCont, et)
                }
              }
              addFill(varBlock, exCont)

              // Token list — extracted from the live instance with mode applied
              if (themeInst) {
                try {
                  let tokens = await extractColorTokens(themeInst)
                  if (tokens.length === 0)
                    tokens = extractHardcodedColors(themeInst)
                  await renderTokenList(
                    varBlock,
                    tokens,
                    varTxtCol,
                    dark ? cDarkMuted : cMuted
                  )
                } catch {
                  /* token extraction optional — skip on error */
                }
              }

              addFill(col, varBlock)
            }
          }
        } else {
          // No appearance variants — single example with token extraction
          const varBlock = mkV("Default Block", 8)
          varBlock.fills = []

          const exCont = mkH("Theme Ex", 0)
          exCont.fills = [sp(exBg)]
          exCont.cornerRadius = 8
          exCont.paddingTop = 20
          exCont.paddingBottom = 20
          exCont.paddingLeft = 20
          exCont.paddingRight = 20
          exCont.primaryAxisAlignItems = "CENTER"
          exCont.counterAxisAlignItems = "CENTER"
          exCont.clipsContent = false
          let themeInst = null
          if (mainComp) {
            try {
              const inst = mainComp.createInstance()
              inst.setExplicitVariableModeForCollection(vt.col, vt.modeId)
              themeInst = inst
              const iw = mkH("IW", 0)
              add(iw, inst)
              add(exCont, iw)
            } catch (e) {
              const et = await mkT(
                `Error: ${e instanceof Error ? e.message : String(e)}`,
                11,
                fR,
                varTxtCol
              )
              add(exCont, et)
            }
          }
          addFill(varBlock, exCont)

          // Token list — extracted from the live instance with mode applied
          if (themeInst) {
            try {
              let tokens = await extractColorTokens(themeInst)
              if (tokens.length === 0)
                tokens = extractHardcodedColors(themeInst)
              await renderTokenList(
                varBlock,
                tokens,
                varTxtCol,
                dark ? cDarkMuted : cMuted
              )
            } catch {
              /* token extraction optional — skip on error */
            }
          }

          addFill(col, varBlock)
        }

        themesGrid.appendChild(col)
        col.layoutSizingHorizontal = "FILL"
      }

      addFill(s, themesGrid)
      docAdd(s)
      // Record natural grid width for later doc-resize step
      themeGridNaturalW = themesGrid.width
    } else if (themeProps.length > 0) {
      await addVariantGridSection("Themes", themeProps, false, formatThemeLabel)
    }
  }

  // ── ACCESSIBILITY ─────────────────────────────────────────────────────────
  const a11y = mdSection(md, [
    "Accessibility",
    "A11y",
    "Screen Reader",
    "Screen Reader Support",
    "Keyboard",
    "Keyboard Navigation",
    "Focus",
    "Focus Management",
    "ARIA"
  ])
  if (a11y) {
    const s = await mkSection("Accessibility")
    const card = mkCard("A11y Card")
    await renderRichText(card, a11y, 20)
    addFill(s, card)
    docAdd(s)
  }

  // ── EXPAND DOC if themes grid is wider than default 1440px ───────────────
  // themeGridNaturalW is the hug-width of the themes comparison grid.
  // All FILL children (every other section) will stretch to the new width.
  if (themeGridNaturalW > 0) {
    const requiredW = Math.min(
      1800,
      Math.max(DOC_W, themeGridNaturalW + DOC_PAD * 2)
    )
    if (requiredW > doc.width) {
      doc.resize(requiredW, 100) // height value ignored — AUTO recalculates
      doc.primaryAxisSizingMode = "AUTO" // must re-set after resize()
      doc.counterAxisSizingMode = "FIXED"
    }
  }

  // ── FOOTER ────────────────────────────────────────────────────────────────
  {
    const div = figma.createRectangle()
    div.resize(doc.width - DOC_PAD * 2, 1)
    div.fills = [sp(cBorder)]
    div.name = "Divider"
    doc.appendChild(div)
    div.layoutSizingHorizontal = "FILL"

    const ft = await mkT(
      `Documentation generator  •  ${displayName}  •  ${new Date().toLocaleDateString(
        "en-US",
        { year: "numeric", month: "long", day: "numeric" }
      )}`,
      15,
      fR,
      cMuted
    )
    addFill(doc, ft)
    makeTextWrap(ft)
  }

  // ── RAW MARKDOWN TEXT NODE ─────────────────────────────────────────────────
  if (md && md.trim().length > 0) {
    // Clean and reorder markdown: deduplicate headings + order by plugin display order
    function cleanAndReorderMd(raw) {
      const lines = raw.split("\n")
      // Split into sections by ## headings
      const sections = []
      let currentTitle = ""
      let currentLines = []
      for (const line of lines) {
        const h2 = line.match(/^##\s+(.+)/)
        if (h2) {
          if (currentTitle || currentLines.length > 0) {
            sections.push({
              title: currentTitle,
              content: currentLines.join("\n").trim()
            })
          }
          currentTitle = h2[1].trim()
          currentLines = []
        } else {
          currentLines.push(line)
        }
      }
      if (currentTitle || currentLines.length > 0) {
        sections.push({
          title: currentTitle,
          content: currentLines.join("\n").trim()
        })
      }

      // Deduplicate: merge sections with the same title (case-insensitive)
      const merged = []
      const titleMap = new Map()
      for (const s of sections) {
        if (!s.title) {
          if (s.content.length > 0) merged.push(s)
          continue
        }
        const key = s.title.toLowerCase().replace(/[-_\s]+/g, "")
        if (titleMap.has(key)) {
          const idx = titleMap.get(key)
          if (s.content) {
            merged[idx].content = merged[idx].content
              ? merged[idx].content + "\n\n" + s.content
              : s.content
          }
        } else {
          titleMap.set(key, merged.length)
          merged.push({ title: s.title, content: s.content })
        }
      }
      const unique = merged

      // Reorder by plugin display order
      const order = [
        "usage",
        "tips",
        "tip",
        "variants",
        "appearance",
        "accessibility",
        "seealso",
        "see also",
        "themes"
      ]
      const orderMap = new Map(order.map((k, i) => [k.replace(/\s+/g, ""), i]))
      function sortKey(title) {
        const normalized = title.toLowerCase().replace(/[-_\s]+/g, "")
        for (const [k, i] of orderMap) {
          if (normalized.includes(k)) return i
        }
        return 100
      }

      // Separate intro (no title) from sections with titles
      const intro = unique.filter(s => !s.title)
      const titled = unique.filter(s => !!s.title)
      titled.sort((a, b) => sortKey(a.title) - sortKey(b.title))

      const result = []
      for (const s of intro) {
        if (s.content) result.push(s.content)
      }
      for (const s of titled) {
        result.push(`## ${s.title}\n\n${s.content}`)
      }
      return result
        .join("\n\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
    }

    const cleanedMd = cleanAndReorderMd(md)

    const mdFrame = figma.createFrame()
    mdFrame.name = `${displayName} — Markdown`
    mdFrame.layoutMode = "VERTICAL"
    mdFrame.primaryAxisSizingMode = "AUTO"
    mdFrame.counterAxisSizingMode = "FIXED"
    mdFrame.resize(800, 100)
    mdFrame.paddingTop = 40
    mdFrame.paddingBottom = 40
    mdFrame.paddingLeft = 40
    mdFrame.paddingRight = 40
    mdFrame.itemSpacing = 0
    mdFrame.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }]
    mdFrame.cornerRadius = 12
    mdFrame.x = doc.x + doc.width + 80
    mdFrame.y = doc.y

    await figma.loadFontAsync({ family: "Source Code Pro", style: "Regular" })
    const mdText = figma.createText()
    mdText.fontName = { family: "Source Code Pro", style: "Regular" }
    mdText.fontSize = 13
    mdText.lineHeight = { value: 150, unit: "PERCENT" }
    mdText.characters = cleanedMd
    mdText.fills = [{ type: "SOLID", color: { r: 0.2, g: 0.2, b: 0.2 } }]
    mdFrame.appendChild(mdText)
    mdText.layoutSizingHorizontal = "FILL"
    mdText.textAutoResize = "HEIGHT"

    affectedNodes.push(mdFrame)
  }

  // Store GitHub info for "check for updates" feature
  if (params.githubUrl && params.githubSha) {
    doc.setPluginData("github-url", params.githubUrl)
    doc.setPluginData("github-sha", params.githubSha)
    doc.setPluginData("github-generated-at", new Date().toISOString())
  }

  doc.setRelaunchData({ [TOOL_ID]: DISPLAY_NAME })
  affectedNodes.push(doc)
  figma.viewport.scrollAndZoomIntoView([doc])
  figma.notify(`✅ Documentation generated for ${displayName}`)

  return { affectedNodes, state: null }
}

async function runAction_generate(target, notify) {
  isExecuting = true
  try {
    const result = await action_generate(latestParams, target, null)
    writeAttachment(target, latestParams, result.state)
    attachRelaunch(result.affectedNodes)
    pushActionStates()
    if (notify) {
      const created = result.affectedNodes.filter(n => n !== target)
      if (created.length > 0) figma.viewport.scrollAndZoomIntoView(created)
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    figma.notify(msg, { error: true })
    throw error
  } finally {
    isExecuting = false
  }
}

function pushActionStates() {
  const t = actionTarget_generate()
  figma.ui.postMessage({
    type: "action-state",
    actions: {
      generate: { enabled: t != null, label: "Generate documentation" }
    }
  })
}

function sendComponentInfo() {
  const target = singleSelectedTarget()
  if (!target) {
    figma.ui.postMessage({
      type: "component-info",
      name: "",
      variantCount: 0,
      propNames: ""
    })
    return
  }
  let name = ""
  let variantCount = 0
  let propNames = ""
  if (target.type === "COMPONENT_SET") {
    const cs = target
    name = cs.name
    variantCount = cs.children.length
    if ("componentPropertyDefinitions" in cs)
      propNames = Object.keys(cs.componentPropertyDefinitions)
        .map(k => k.replace(/#\d+$/, ""))
        .join(", ")
  } else if (target.type === "COMPONENT") {
    const c = target
    name = c.parent?.type === "COMPONENT_SET" ? c.parent.name : c.name
    variantCount =
      c.parent?.type === "COMPONENT_SET" ? c.parent.children.length : 1
    const ss = c.parent?.type === "COMPONENT_SET" ? c.parent : c
    if ("componentPropertyDefinitions" in ss)
      propNames = Object.keys(ss.componentPropertyDefinitions)
        .map(k => k.replace(/#\d+$/, ""))
        .join(", ")
  } else if (target.type === "INSTANCE") {
    name = target.name
    variantCount = 1
  } else {
    name = target.name
  }
  figma.ui.postMessage({
    type: "component-info",
    name,
    variantCount,
    propNames
  })
}

function refreshSelection() {
  if (isExecuting) return
  const target = singleSelectedTarget()
  const attachment = target != null ? readAttachment(target) : null
  latestParams = attachment?.params ?? DEFAULTS
  figma.ui.postMessage({ type: "params-change", params: latestParams })
  sendComponentInfo()
  pushActionStates()
}

// ── Init ───────────────────────────────────────────────────────────────────────
const initialTarget = singleSelectedTarget()
const initialAttachment =
  initialTarget != null ? readAttachment(initialTarget) : null
const initialParams = initialAttachment?.params ?? DEFAULTS
latestParams = initialParams

let html = __html__
html = html.replace(
  /(id="dsLink"[^>]*\bvalue=")[^"]*(")/g,
  "$1" + htmlEsc(initialParams.dsLink) + "$2"
)

figma.root.setRelaunchData({ [TOOL_ID]: DISPLAY_NAME })
figma.showUI(html, { width: 300, height: 420 })
pushActionStates()
sendComponentInfo()
figma.on("selectionchange", refreshSelection)

figma.ui.onmessage = msg => {
  if (msg.type === "resize") {
    figma.ui.resize(300, Math.max(200, Math.min(900, Math.round(msg.height))))
    return
  }
  if (msg.type === "save-gh-token") {
    void figma.clientStorage.setAsync("gh-token", msg.token)
    return
  }
  if (msg.type === "get-gh-token") {
    void figma.clientStorage.getAsync("gh-token").then(token => {
      figma.ui.postMessage({ type: "gh-token", token: token || "" })
    })
    return
  }
  if (msg.type === "get-github-info") {
    const target = singleSelectedTarget()
    if (!target) {
      figma.ui.postMessage({
        type: "github-info",
        url: "",
        sha: "",
        generatedAt: ""
      })
      return
    }
    // Look for doc frame generated by this plugin (child of page or sibling)
    const page = figma.currentPage
    let docFrame = null
    for (const child of page.children) {
      if (child.type === "FRAME" && child.getPluginData("github-sha")) {
        docFrame = child
        break
      }
    }
    if (docFrame && docFrame.type === "FRAME") {
      figma.ui.postMessage({
        type: "github-info",
        url: docFrame.getPluginData("github-url"),
        sha: docFrame.getPluginData("github-sha"),
        generatedAt: docFrame.getPluginData("github-generated-at")
      })
    } else {
      figma.ui.postMessage({
        type: "github-info",
        url: "",
        sha: "",
        generatedAt: ""
      })
    }
    return
  }
  if (msg.type === "action" && msg.id === "generate") {
    const target = actionTarget_generate()
    if (target == null) return
    latestParams = normalizeParams(msg.params)
    void runAction_generate(target, true)
  }
}
