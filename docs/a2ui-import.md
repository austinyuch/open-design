# A2UI import

OpenDesign can render a low-fidelity [A2UI](https://github.com/a2ui-project/a2ui)
contract as a design-system-styled, high-fidelity HTML artifact. An A2UI
message stream goes in; HTML that uses the active design system's tokens and
component classes comes out, with every A2UI component id kept on the element
that renders it.

## Supported version and schema pin

| | |
| --- | --- |
| A2UI protocol version | **1.0** only. Any other `version` fails with `A2UI-V1-VERSION`. |
| Schemas | `specification/v1_0/json/agent_to_renderer.json`, `specification/v1_0/json/common_types.json` |
| Catalog | Basic Catalog `catalogs/basic/v1/catalog.json` (`catalogId` `https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json`) |
| Upstream | `a2ui-project/a2ui` at commit `172cf31e1acbce31c4e60d82b2edbd923b279dd8` |
| Vendored copy | `apps/daemon/src/a2ui/vendor/a2ui-v1_0/` with `LICENSE` (Apache-2.0) and `provenance.json` (per-file SHA-256) |

The schemas are read from the vendored copy. Their `$id`, `$ref` and `$schema`
URLs are identifiers only: validation runs offline and never fetches anything.
To move the pin, replace the vendored files from the new upstream commit,
update `provenance.json` and `A2UI_SCHEMA_PIN` in
`apps/daemon/src/a2ui/import.ts`, and rerun the daemon tests.

## Entry points

Both surfaces call the same daemon endpoint.

```bash
od import a2ui ui.a2ui.jsonl --design-system agentic --out ui.html
od import a2ui - --design-system agentic --json < ui.a2ui.json
```

`POST /api/a2ui/import` with `{ "stream": <JSON/JSONL text or message array>, "designSystemId": "<id>" }`
returns `200` with `A2uiImportSuccess` or `422` with `A2uiImportFailure`
(types in `packages/contracts/src/api/a2ui-import.ts`). The CLI exits `0` on
success, `1` on typed import errors, `2` on usage errors and `3` when the daemon
is unreachable.

## Input

- A JSON array of messages, a `{ "messages": [...] }` sample object, or JSON
  Lines (one message per line).
- Importable messages: `createSurface`, `updateComponents`, `updateDataModel`,
  `deleteSurface`. They are replayed in order; data bindings (`{"@path": ...}`)
  resolve against the final data model. Deleted surfaces are not rendered.
- `callRendererFunction` and `agentFunctionResponse` are runtime messages and
  fail with `A2UI-V1-MESSAGE-UNSUPPORTED`.

## Typed errors

Invalid input never produces HTML. Unknown catalogs and components are
rejected, never guessed.

| Code | Meaning |
| --- | --- |
| `A2UI-V1-STREAM-MALFORMED` | Not JSON / JSON Lines, or a message is not an object |
| `A2UI-V1-VERSION` | `version` is not `"1.0"` |
| `A2UI-V1-SCHEMA` | Violates the pinned JSON Schema (path points at the offending value) |
| `A2UI-V1-MESSAGE-UNSUPPORTED` | A runtime message in a static import |
| `A2UI-V1-SURFACE-UNKNOWN` / `-DUPLICATE` | Update or delete of a surface that does not exist / create of one that does |
| `A2UI-V1-CATALOG-UNKNOWN` | A `catalogId` other than the Basic Catalog |
| `A2UI-V1-COMPONENT-UNKNOWN` | A component the catalog does not define (or the reserved `Surface`) |
| `A2UI-V1-ID-DUPLICATE` | The same id twice in one components list |
| `A2UI-V1-ROOT-MISSING`, `-CHILD-DANGLING`, `-CYCLE` | The adjacency list is not a tree rooted at `root` |
| `A2UI-V1-DESIGN-SYSTEM-UNKNOWN` | No such design system |
| `A2UI-V1-MAPPING-MISSING` / `-INVALID` / `-UNMAPPED` | The design system has no mapping, a malformed one, or none for a component the stream uses |

Warnings do not fail the import: `A2UI-V1-UNREACHABLE` (a component `root`
never reaches; it is still emitted inside `<template data-a2ui-unreachable>` so
its id survives) and `A2UI-V1-URL-REJECTED` (a media URL with a scheme other
than http(s), relative or `data:image/` is dropped).

## Design-system mapping

A design system opts in by shipping `a2ui.mapping.json` next to its
`tokens.css`. The importer owns element semantics, so every design system gets
the same accessible structure (a `Button` is a `<button>`, a `TextField` is an
`<input>` inside its `<label>`, a `ChoicePicker` is a `<fieldset>` with a
`<legend>`); the mapping only supplies classes.

```json
{
  "schema": "open-design/a2ui-mapping/v1",
  "a2uiVersion": "1.0",
  "catalogId": "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json",
  "components": {
    "Card": { "class": "panel" },
    "Button": { "class": "btn btn-secondary", "variants": { "primary": "btn btn-primary" } }
  }
}
```

The output inlines the design system's `tokens.css` and the `<style>` blocks of
its `components.html`. `design-systems/agentic/a2ui.mapping.json` is the
reference mapping and covers every Basic Catalog component.

## What survives into the HTML

- `data-a2ui-id` on the element of every component (template rows also carry
  `data-a2ui-index`), `data-a2ui-component` with the A2UI component name, and
  `data-a2ui-surface` on each surface's `<section>`.
- Labels as visible label text; `@accessibility.label` as `aria-label`.
- Action targets as `data-a2ui-action` (event name) with
  `data-a2ui-action-context`, or `data-a2ui-function` for a function call.
- Data bindings as `data-a2ui-path`.

Run `od lint` on the result: the accessibility rules (`low-contrast-text`,
`low-contrast-ui`, `missing-accessible-name`, `target-size-min`,
`contrast-unresolved`) check the hi-fi output against WCAG 2.2.
