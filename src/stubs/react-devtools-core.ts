/**
 * Stub de `react-devtools-core`.
 *
 * O `ink/build/reconciler.js` referencia esse pacote para conectar ao React
 * DevTools quando `process.env.DEV === 'true'`. O guard nunca é verdadeiro em
 * produção, mas o `bun build --compile` resolve o import estaticamente ao
 * montar o bundle e falha ("Could not resolve"). Marcar como `--external`
 * também não serve: o binário single-file não tem `node_modules` para procurar
 * em runtime, e aí quebra ao iniciar.
 *
 * Este stub é mapeado via `paths` no tsconfig e satisfaz o bundler. Se alguém
 * realmente quiser depurar com DevTools, roda por `bun src/cli.ts` (sem
 * compilar) e instala o pacote de verdade.
 */
export default {
	initialize() {},
	connectToDevTools() {},
};
