---
name: allen-design
description: Use this skill to generate well-branded interfaces and assets for Allen, either for production or throwaway prototypes/mocks/etc. Contains essential design guidelines, colors, type, fonts, assets, and UI kit components for prototyping.
user-invocable: true
---

Read the README.md file within this skill, and explore the other available files.

If creating visual artifacts (slides, mocks, throwaway prototypes, etc), copy assets out and create static HTML files for the user to view. If working on production code, you can copy assets and read the rules here to become an expert in designing with this brand.

If the user invokes this skill without any other guidance, ask them what they want to build or design, ask some questions, and act as an expert designer who outputs HTML artifacts _or_ production code, depending on the need.

Key things to remember about Allen:

- **Allen is an agentic OS for software development** — a multi-team agent org you point at codebases.
- **Voice:** clipped, lowercase nav, sentence-case buttons, no emoji, no exclamation marks, identifiers in mono.
- **Type:** Inter Tight (sans) + JetBrains Mono (mono labels, badges, IDs, paths). Both Google Fonts.
- **Color:** a single blue accent (`#2A76E2`) for actions and active state; saturated colors (green/red/yellow/cyan/purple) reserved for run state. Off-white surfaces in light mode, near-black in dark mode.
- **Chrome:** 1px borders everywhere; soft shadows only on popovers; 6–12px radii (never 16+); no gradients, no imagery, no emoji.
- **Icons:** Lucide React only, outline style, 16px default.
- **Brand mark:** the monospace `[a]` capsule in soft-accent. Logomark in `assets/allen-mark.svg`.
- **Layout:** 220px sidebar + 52px topbar shell; pages padded `24/20/32`; tables use mono uppercase headers.

The `ui_kits/allen-app/` folder has a working React recreation of the core surfaces — sidebar, topbar, chat, executions, workspaces, library. Open `index.html` to see them assembled, or pull individual `.jsx` components into a new mock.

The `colors_and_type.css` file at the root of this skill is import-ready and defines every token plus a small helper class layer (`.btn`, `.input`, `.badge-*`, `.chip`, `.kbd`, `.ds-card`, `.overline`, `.meta`).
