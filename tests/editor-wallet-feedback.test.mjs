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
const harness = { slots: [], cursor: 0, effects: [],
  deploy: async (_signer, _signal, log) => { log('Wallet already deployed.'); } };
globalThis.__editorFeedback = harness;
globalThis.window = {addEventListener(){},removeEventListener(){}};
const saved = new Map();
globalThis.localStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
try {
await build({ entryPoints: [path.join(root, 'apps/web/src/components/evml-editor.tsx')], outfile: path.join(out, 'editor.mjs'),
  bundle: true, platform: 'node', format: 'esm', packages: 'external', tsconfigRaw: {}, jsx: 'automatic',
  plugins: [{ name: 'editor-services', setup(b) {
    b.onResolve({ filter: /^(react(?:$|\/jsx-runtime$)|@evmcrispr\/)|\.css$|\/lib\// }, args => args.path.endsWith('/evml-history') ? undefined : ({ path: args.path, namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path: name }) => {
      let contents = '';
      if (name === 'react/jsx-runtime') contents = 'export const jsx=(type,props)=>({type,props}); export const jsxs=jsx; export const Fragment="fragment";';
      else if (name === 'react') contents = `const h = globalThis.__editorFeedback;
        export const useState = initial => { const i=h.cursor++; if (!(i in h.slots)) h.slots[i]=initial; return [h.slots[i], v=>{ h.slots[i]=typeof v==='function'?v(h.slots[i]):v; }]; };
        export const useRef = initial => { const i=h.cursor++; return h.slots[i] ??= {current:initial}; };
        const same = (a,b) => a && b && a.length===b.length && a.every((v,i)=>Object.is(v,b[i]));
        export const useEffect = (fn,deps) => { const i=h.cursor++, previous=h.slots[i]; if (!same(previous?.deps,deps)) {
          const slot={deps}; h.slots[i]=slot; h.effects.push(()=>{previous?.cleanup?.(); slot.cleanup=fn();});
        } };
        export const useMemo = (fn,deps) => { const i=h.cursor++; if (!same(h.slots[i]?.deps,deps)) h.slots[i]={deps,value:fn()}; return h.slots[i].value; };
        export const useCallback = (fn,deps) => useMemo(()=>fn,deps);`;
      else if (name === '@evmcrispr/core') contents = 'export const createEvml=()=>({use(){return this;}});';
      else if (name === '@evmcrispr/editor') contents = 'export const EvmcrisprTerminal=()=>null;';
      else if (name.endsWith('/privacy/runtime')) contents = `export class PrivateScriptRuntime {
        constructor(changed, record){this.changed=changed; globalThis.__editorFeedback.recordPrivate=record;} restore(){this.changed({viewing:false,wallet:{address:'0x50540e86745775A8a45c1528e66679f98bdFD375'}});} lock(){}
        deploy(...args){return globalThis.__editorFeedback.deploy(...args);}
        handler(){return async()=>{};}
      }`;
      else if (name.endsWith('/frame-rpc')) contents = `export const rpc=async (_,method)=>method==='eth_getBlockByNumber'?{hash:'0xcd2c67c2bd8cb5458eb2d878877668a0b86ed19fed44fbc874f3254106b97b88'}:method==='eth_chainId'?'0x539':'0x1'; export const shortHex=v=>v; export const transportOf=()=>({});`;
      else if (name.endsWith('/evml-frames')) contents = 'export const makeFrameHandler=({onUpdate})=>async update=>onUpdate(update); export const refuseOtherActions=()=>({});';
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
const flushEffects = async () => {
  for (const effect of harness.effects.splice(0)) effect();
  await settle();
};
const refresh = async () => {
  for (const slot of harness.slots) slot?.cleanup?.();
  harness.slots=[]; harness.effects=[];
  render();
  await flushEffects();
};
const find = (node, predicate) => {
  if (!node || typeof node !== 'object') return;
  if (predicate(node)) return node;
  for (const child of [node.props?.children].flat(Infinity)) { const found=find(child,predicate); if(found) return found; }
};
const content = () => JSON.stringify(render(), (_, value) => typeof value === 'bigint' ? String(value) : value);
const selectNetwork = async value => {
  find(render(), node => node.type === 'select').props.onChange({target:{value}});
  render();
  await flushEffects();
};
  render();
  await flushEffects();
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
  await test('confirmed private transactions remain visible after a page refresh', async () => {
    const hash = `0x${'ab'.repeat(32)}`;
    harness.recordPrivate({ hash, frameCount: 3 });
    harness.recordPrivate({ hash, frameCount: 3, receipt: {
      transactionHash: hash, blockHash: `0x${'cd'.repeat(32)}`, blockNumber: '0x2a', status: '0x1',
      frameReceipts: Array.from({ length: 3 }, () => ({ status: '0x1' })),
    } });
    assert.match(content(), /Included/);
    await refresh();
    assert.ok(content().includes(hash), 'refresh should retain the transaction hash');
    assert.match(content(), /Included/);
    assert.match(content(), /block 42/);
    const rows = find(render(), node => node.props?.className === 'evml-sent').props.children;
    assert.equal(rows.length, 1, 'receipt updates should replace the pending entry');
  });
  await test('network switches isolate public history and private updates remain on devnet', async () => {
    const privateHash = `0x${'ab'.repeat(32)}`;
    const localHash = `0x${'ef'.repeat(32)}`;
    await selectNetwork('local');
    assert.ok(!content().includes(privateHash));
    const terminal = find(render(), node => node.type?.name === 'EvmcrisprTerminal');
    await terminal.props.executeAction({execute: async (_, options) => options.handlers.frame({hash:localHash,frameCount:2}, {})});
    harness.recordPrivate({hash:privateHash,frameCount:3});
    assert.ok(content().includes(localHash));
    assert.ok(!content().includes(privateHash));
    await selectNetwork('devnet');
    assert.ok(content().includes(privateHash));
    assert.match(content(), /Included/, 'pending restoration must not discard a known receipt');
    assert.ok(!content().includes(localHash));
    await refresh();
    await selectNetwork('local');
    assert.ok(content().includes(localHash), 'public history also survives a refresh');
    assert.ok(!content().includes(privateHash));
  });
  await test('rejected transactions keep their reason and label after refresh', async () => {
    const hash = `0x${'78'.repeat(32)}`;
    harness.recordPrivate({hash,frameCount:5,outcome:'rejected',error:'Gateway rejected transaction (gas-limit).'});
    await refresh();
    assert.ok(content().includes(hash));
    assert.match(content(), /Rejected/);
    assert.match(content(), /gas-limit/);
  });
  await test('history keeps the latest 30 entries and tolerates unavailable storage', async () => {
    await selectNetwork('devnet');
    for (let i=1; i<=31; i++) harness.recordPrivate({hash:`0x${i.toString(16).padStart(64,'0')}`,frameCount:2});
    await refresh();
    const rows = find(render(), node => node.props?.className === 'evml-sent').props.children;
    assert.equal(rows.length, 30);
    assert.ok(!content().includes(`0x${'1'.padStart(64,'0')}`));
    const storage = globalThis.localStorage;
    globalThis.localStorage = {getItem(){throw new Error('blocked');},setItem(){throw new Error('quota');}};
    try {
      await refresh();
      const hash = `0x${'12'.repeat(32)}`;
      harness.recordPrivate({hash,frameCount:2});
      assert.ok(content().includes(hash), 'storage failure must not hide new submissions');
    } finally { globalThis.localStorage=storage; }
  });
  await test('malformed saved history does not break the editor', async () => {
    saved.clear();
    harness.recordPrivate({hash:`0x${'34'.repeat(32)}`,frameCount:2});
    const key = [...saved.keys()][0];
    for (const raw of ['{', '{}', '[null,{"hash":"bad"}]', JSON.stringify([
      {hash:`0x${'56'.repeat(32)}`,frameCount:2,receipt:{blockNumber:'invalid'}},
    ])]) {
      saved.set(key,raw);
      await refresh();
      assert.match(content(), /No saved transactions/);
    }
  });
} finally { delete globalThis.__editorFeedback; delete globalThis.window; delete globalThis.localStorage; await rm(out, {recursive:true,force:true}); }
