const { buildSync } = require('esbuild')
buildSync({
  tsconfigRaw: {},
  entryPoints: ['public/map-viewer.mjs'],
  bundle: true,
  minify: true,
  outfile: 'public/dist/map-viewer.js',
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'eof',
})
