# Geist (Vercel) Design Reference for Entry Desktop

Studied from vercel.com/geist (official docs), plus authoritative third-party
analyses. This file is the binding spec for Entry Desktop's UI. Where a value
is inferred from analysis rather than copied from Vercel's runtime tokens, it
is marked "inferred".

## Philosophy

Minimalism as engineering principle, not decoration. The interface is treated
like compiled code: every unnecessary token stripped until only structure
remains. Performance is the design. Documentation-grade contrast. Black is
black. White is white.

## Foundations

### Color (Geist scale system)

Ten scales (`backgrounds`, `gray`, `gray-alpha`, `blue`, `red`, `amber`,
`green`, `teal`, `purple`, `pink`). Every non-background scale has 10 steps
(100–1000) with a fixed usage contract:

- 100 — default background
- 200 — hover background
- 300 — active background
- 400 — default border
- 500 — hover border
- 600 — active border
- 700 — high-contrast background
- 800 — hover high-contrast background
- 900 — secondary text/icons
- 1000 — primary text/icons

Two backgrounds only:
- Background 1 — default element/page background
- Background 2 — secondary background (use sparingly, subtle differentiation)

Key anchors (light mode): Gray-1000 `#000000`, Gray-900 `#171717` (Vercel
Black — primary text/headings, not pure black in practice), Gray-600 `#4d4d4d`
(secondary text), Gray-400 `#808080` (placeholder), Gray-100 `#ebebeb`
(borders), Background `#ffffff`.

Dark mode (inferred from Vercel dashboard): Background 1 `#0a0a0a`, Background
2 `#111111`, borders `#333`, secondary text `#a1a1aa`-ish, primary text
`#ededed`. Vercel dark surfaces are near-black, never pure `#000` chrome on
`#000` chrome — differentiation comes from subtle background lift + borders.

**Rules:**
- Don't use warm colors in UI chrome.
- Workflow accents (Develop blue `#0a72ef`, Preview pink `#de1d8d`, Ship red
  `#ff5b4f`) are semantic, never decorative. Accent coverage < 1% of surface.
- No gradients.

### Typography

Geist Sans (UI/display) + Geist Mono (code, terminal, technical labels, IDs).
Both OFL, free for commercial redistribution. OpenType `liga` on globally.

Three-weight system: **400** body, **500** UI/buttons/links, **600** headings.
Weight 700 is forbidden on body text; 600 is the maximum, headings only.

Named type presets bundle size + line-height + weight + tracking:

| Preset | Size | Weight | LH | Tracking |
|---|---|---|---|---|
| heading-72 | 72px | 600 | 1.0 | -4.32px |
| heading-48 | 48px | 600 | 1.0–1.17 | -2.4px |
| heading-40 | 40px | 600 | 1.2 | -2.4px |
| heading-32 | 32px | 600 | 1.25 | -1.28px |
| heading-24 | 24px | 600 | 1.33 | -0.96px |
| heading-16 | 16px | 600 | 1.5 | -0.32px |
| copy-24 | 24px | 400 | 1.8 | normal |
| copy-20 | 20px | 400 | 1.8 | normal |
| copy-18 | 18px | 400 | 1.56 | normal |
| copy-16 | 16px | 400 | 1.5 | normal |
| copy-14 | 14px | 400 | 1.43 | normal |
| copy-13-mono | 13px mono | 400 | — | normal |

**Compression as identity**: display sizes use aggressive negative tracking
(most aggressive of any major system — text feels "minified like production
code"). Body tracking is normal/zero. Never positive tracking on Geist Sans.

Label presets (single-line, icon-pairing): label-14 is the most common text
style in menus; label-13 pairs with it; mono variants (`text-label-14-mono`,
`text-label-13-mono`) pair with larger text in technical contexts.

### Shadow-as-border

Vercel does not use traditional CSS borders on cards. Instead:

```
box-shadow: 0 0 0 1px rgba(0,0,0,0.08);   /* the "border" */
```

Multi-layer stacks (light mode, inferred):
```
0 0 0 1px rgba(0,0,0,0.08),   /* border ring    */
0 1px 2px rgba(0,0,0,0.04),   /* soft ambient   */
0 4px 8px rgba(0,0,0,0.04)    /* depth at range */
```

Dark mode: borders carry elevation (`#333` hairlines + background lift),
shadows are whisper-level or absent. Never > 0.1 opacity shadows. The inner
`#fafafa` ring on light cards is part of the system — don't skip it.

### Materials (radii)

- base / small: 6px (everyday surfaces, buttons, inputs)
- medium / large: 12px (menus, modals)
- fullscreen: 16px
- tooltips: 6px
- pills/badges: 9999px — **badges and tags only, never primary buttons**

### Spacing

Base unit 8px. Scale: 1,2,3,4,5,6,8,10,12,14,16,32,36,40 — the scale jumps
16→32 (no 20/24 in primary scale). "Gallery emptiness": massive vertical
padding between sections (80–120px). White space IS the design. Compressed
text is counterbalanced by expanded space.

### Buttons

- Primary: `#171717` bg, white text, 6px radius, 8px×16px padding,
  `text-button-14` (14px/500)
- Secondary: white bg, shadow-as-border, same metrics
- Tertiary/ghost: no bg, no border; hover = gray-100 fill
- Variants: default / error / warning / secondary / tertiary (NOT
  primary/success/ghost/violet as *type* values)
- States: loading (in-place, stays focusable), disabled (only when action is
  impossible), hover border shifts gray-400→gray-500
- Title Case labels naming the action: "Deploy Project", not "Submit"/"OK"
- Icon-only buttons require `aria-label` naming action+target, not the icon

### Focus / accessibility

Focus ring: saturated blue `hsla(212, 100%, 48%, 1)`. Guides and decorative
elements are `aria-hidden`; semantics live on content. Labels name action +
target. Icon-only controls must carry accessible names.

### Motion

Fast, minimal: 100–150ms ease-out. No springy/long transitions.

### Grid

Guide-line grids (visible rules + cells) are a marketing/docs device; plain
app content uses simple `grid` utilities. Guides are decorative.

## Application rules for Entry Desktop

1. Dark-first (goal.md UI bar) — near-black `#0a0a0a` surface, `#111` lift,
   hairline `#333` borders, text `#ededed`/`#a1a1aa`. No gradients, no glow.
2. Geist Sans for UI, Geist Mono for command input, output, and any technical
   label. `liga` on.
3. Heading: weight 600, negative tracking scaled to size. Body: 400, normal
   tracking. Never 700 body.
4. Accent usage: the Develop blue `#0a72ef` only for focus rings; semantic
   red `#ff4d4f`-family only for stderr/errors; nothing else gets color.
5. 6px radius on controls, 12px on panels. Pills only for status badges
   (git branch, exit-code chip).
6. Shadow-as-border translates to dark mode as hairline borders + subtle
   background lift; no heavy shadows.
7. Spacing on the Geist scale; section gaps generous (32+), control gaps
   small (8–12).
8. Motion 100–150ms ease-out on hover/state changes only.
