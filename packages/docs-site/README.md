# Allen documentation site

This package contains the Docusaurus documentation site for Allen.

## Local development

From the repository root:

```bash
npm run docs:dev
```

The dev server serves the docs at `http://127.0.0.1:3000/docs/`.

## Build

```bash
npm run docs:build
```

The static site is written to `packages/docs-site/build/`.

## Export for askallen.build

The docs are configured to run under `/docs/` on `askallen.build`. To create a folder that can be copied into the Allen website deployment:

```bash
npm run docs:export
```

Copy `packages/docs-site/deploy/docs/` into the website deployment at `public/docs/` or the equivalent static asset directory. No application route changes are required if the hosting layer serves static files from `/docs/`.
