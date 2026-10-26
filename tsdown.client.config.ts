import { defineConfig } from 'tsdown'

/**
 * Client-half bundle: `src/client/index.ts` → `lib/client.js`, one prebuilt
 * CommonJS file wrapped by the banner/footer/intro into the
 * `window.__ModuleLoader__.load({ id, factory })` contract — the same shape
 * the host `clientBundle` preset and dsh-websearch use. Externals are the
 * frozen module table: react basics plus the primitives package whose
 * `Tooltip` and icons resolve to the host's own single instance (declared in
 * `dsh.client.external` so the module loader serves it).
 */
export default defineConfig({
  entry: ['src/client/index.ts'],
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  // Shares `lib/` with the node-half build; never clean sibling outputs.
  clean: false,
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/dsh-client-ui-primitives'],
  outputOptions: {
    entryFileNames: 'client.js',
    inlineDynamicImports: true,
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify('dsh-subagent-plus')}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
