// Monaco Editor loader (AMD, via CDN) + thin helpers.
// Loaded lazily so the initial page paints fast.

const MONACO_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.47.0/min/vs';

let monacoReadyPromise = null;

export function loadMonaco() {
  if (monacoReadyPromise) return monacoReadyPromise;
  monacoReadyPromise = new Promise((resolve, reject) => {
    const loaderScript = document.createElement('script');
    loaderScript.src = `${MONACO_BASE}/loader.js`;
    loaderScript.onload = () => {
      // eslint-disable-next-line no-undef
      require.config({ paths: { vs: MONACO_BASE } });
      // eslint-disable-next-line no-undef
      require(['vs/editor/editor.main'], () => {
        resolve(window.monaco);
      });
    };
    loaderScript.onerror = reject;
    document.head.appendChild(loaderScript);
  });
  return monacoReadyPromise;
}

const EXT_LANG_MAP = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php',
  html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
  json: 'json', yml: 'yaml', yaml: 'yaml', xml: 'xml', md: 'markdown',
  markdown: 'markdown', sh: 'shell', bash: 'shell', sql: 'sql',
  dart: 'dart', kt: 'kotlin', swift: 'swift', txt: 'plaintext',
  toml: 'ini', ini: 'ini', dockerfile: 'dockerfile', lua: 'lua', r: 'r'
};

export function languageForPath(path) {
  const fileName = path.split('/').pop() || '';
  if (/^dockerfile$/i.test(fileName)) return 'dockerfile';
  const ext = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '';
  return EXT_LANG_MAP[ext] || 'plaintext';
}

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'pdf', 'zip', 'gz', 'tar',
  '7z', 'rar', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp3', 'mp4', 'mov', 'avi',
  'exe', 'dll', 'so', 'class', 'jar', 'wasm'
]);

export function isLikelyBinary(path) {
  const ext = path.includes('.') ? path.split('.').pop().toLowerCase() : '';
  return BINARY_EXTENSIONS.has(ext);
}

export function createModel(monaco, content, path) {
  return monaco.editor.createModel(content, languageForPath(path));
}
