import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Execute the real editor component and its click handler with deterministic
// hooks and service boundaries; no browser credential or transaction is used.
const root = path.resolve(import.meta.dirname, '..');
const out = await mkdtemp(path.join(root, '.framepay/editor-feedback-'));
const harness = { slots: [], cursor: 0, effects: [], initialized: false,
  deploy: async (_signer, _signal, log) => { log('Wallet already deployed.'); } };
globalThis.__editorFeedback = harness;
globalThis.window = {addEventListener(){},removeEventListener(){}};
try {
await build({ entryPoints: [path.join(root, 'apps/web/src/components/evml-editor.tsx')], outfile: path.join(out, 'editor.mjs'),
  bundle: true, platform: 'node', format: 'esm', packages: 'external', tsconfigRaw: {}, jsx: 'automatic',
  plugins: [{ name: 'editor-services', setup(b) {
    b.onResolve({ filter: /^(react(?:$|\/jsx-runtime$)|@evmcrispr\/)|\.css$|\/lib\// }, args => ({ path: args.path, namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path: name }) => {
      let contents = '';
      if (name === 'react/jsx-runtime') contents = 'export const jsx=(type,props)=>({type,props}); export const jsxs=jsx; export const Fragment="fragment";';
      else if (name === 'react') contents = `const h = globalThis.__editorFeedback;
        export const useState = initial => { const i=h.cursor++; if (!(i in h.slots)) h.slots[i]=initial; return [h.slots[i], v=>{ h.slots[i]=typeof v==='function'?v(h.slots[i]):v; }]; };
        export const useRef = initial => { const i=h.cursor++; return h.slots[i] ??= {current:initial}; };
        export const useEffect = fn => { if (!h.initialized) h.effects.push(fn); };
        export const useCallback = fn => fn; export const useMemo = fn => fn();`;
      else if (name === '@evmcrispr/core') contents = 'export const createEvml=()=>({use(){return this;}});';
      else if (name === '@evmcrispr/editor') contents = 'export const EvmcrisprTerminal=()=>null;';
      else if (name.endsWith('/privacy/runtime')) contents = `export class PrivateScriptRuntime {
        constructor(changed){this.changed=changed;} restore(){this.changed({viewing:false,wallet:{address:'0x50540e86745775A8a45c1528e66679f98bdFD375'}});} lock(){}
        deploy(...args){return globalThis.__editorFeedback.deploy(...args);}
      }`;
      else if (name.endsWith('/frame-rpc')) contents = `export const rpc=async (_,method)=>method==='eth_getBlockByNumber'?{hash:'0xcd2c67c2bd8cb5458eb2d878877668a0b86ed19fed44fbc874f3254106b97b88'}:method==='eth_chainId'?'0x539':'0x1'; export const shortHex=v=>v; export const transportOf=()=>({});`;
      else if (name.endsWith('/evml-frames')) contents = 'export const makeFrameHandler=()=>{}; export const refuseOtherActions={};';
      else if (name.endsWith('/privacy/frame-plan')) contents = 'export const hasPrivateFrames=()=>false;';
      else if (!name.endsWith('.css')) contents = 'export default {};';
      return { contents, loader: 'js' };
    });
  }}],
});
const { default: Editor } = await import(pathToFileURL(path.join(out, 'editor.mjs')));
const render = () => { harness.cursor=0; return Editor(); };
const findPanel = node => {
  if (!node || typeof node !== 'object') return;
  if (node.type?.name === 'PrivateScriptWalletPanel') return node;
  for (const child of [node.props?.children].flat(Infinity)) { const found=findPanel(child); if(found) return found; }
};
const settle = () => new Promise(resolve => setImmediate(resolve));
  render(); harness.initialized=true;
  for (const effect of harness.effects) effect();
  await settle();
  await test('Deploy click surfaces the already-deployed result in the wallet panel', async () => {
    findPanel(render()).props.onTask('deploy');
    await settle();
    const panel = findPanel(render());
    assert.match(JSON.stringify(panel.type(panel.props)), /Wallet already deployed\./);
  });
  await test('confirmed deployed wallets hide Deploy while undeployed wallets keep it', () => {
    const panel = findPanel(render());
    for (const deploymentStatus of ['deployed', 'undeployed']) {
      const props = { ...panel.props, state: { ...panel.props.state, deploymentStatus } };
      const content = JSON.stringify(panel.type(props));
      if (deploymentStatus === 'deployed') {
        assert.doesNotMatch(content, /"children":"Deploy wallet"/);
        assert.match(content, /Deployed on Framecraft devnet/);
      } else assert.match(content, /"children":"Deploy wallet"/);
    }
  });
  await test('Deploy click shows progress while waiting and displays failures beside the wallet', async () => {
    let reject;
    harness.deploy = () => new Promise((_, fail) => { reject = fail; });
    findPanel(render()).props.onTask('deploy');
    let panel = findPanel(render());
    assert.equal(panel.props.disabled, true);
    assert.match(JSON.stringify(panel.type(panel.props)), /Deploying…/);
    reject(new Error('Gateway request timed out'));
    await settle();
    panel = findPanel(render());
    assert.equal(panel.props.disabled, false);
    assert.equal(panel.props.feedback.error, true);
    assert.match(JSON.stringify(panel.type(panel.props)), /Gateway request timed out/);
  });
} finally { delete globalThis.__editorFeedback; delete globalThis.window; await rm(out, {recursive:true,force:true}); }
