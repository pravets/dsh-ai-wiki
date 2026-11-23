import { existsSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function readJson(file) {
  try {
    if (!existsSync(file) || !statSync(file).isFile()) return { data: null, error: null };
    const text = readFileSync(file, 'utf8');
    return { data: JSON.parse(text), error: null };
  } catch (error) {
    return { data: null, error: error && error.message ? error.message : String(error) };
  }
}

export function expandPath(value, cwd, env) {
  let text = String(value === null || value === undefined ? '' : value).trim();
  if (text === '') return text;
  if (text === '~') text = os.homedir();
  else if (text.startsWith('~/') || text.startsWith('~\\')) text = path.join(os.homedir(), text.slice(2));
  text = text.replace(/%([^%]+)%/g, function (_match, name) {
    return env[name] === undefined ? _match : env[name];
  });
  text = text.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, function (_match, name) {
    return env[name] === undefined ? _match : env[name];
  });
  return path.isAbsolute(text) ? path.normalize(text) : path.resolve(cwd, text);
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  if (process.platform === 'win32') return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

export function detectVault(cwd) {
  let dir = path.resolve(cwd);
  for (let depth = 0; depth < 8; depth += 1) {
    const agents = path.join(dir, 'AGENTS.md');
    if (existsSync(agents)) {
      let text = '';
      try {
        text = readFileSync(agents, 'utf8');
      } catch {
        text = '';
      }
      const looksLikeVault = text.includes('Vault Contract') || text.includes('Зоны и права') || text.includes('LLM Wiki');
      const hasZone = existsSync(path.join(dir, '10-wiki')) || existsSync(path.join(dir, '15-precedent')) || existsSync(path.join(dir, '90-meta'));
      const hasMarker = existsSync(path.join(dir, '.llm-ro')) || existsSync(path.join(dir, '.llm-rw')) || existsSync(path.join(dir, '.llm-append'));
      if (looksLikeVault && (hasZone || hasMarker)) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function normalizeVault(raw, context, errors) {
  if (typeof raw === 'string') {
    const abs = expandPath(raw, context.cwd, context.env);
    return {
      name: path.basename(abs),
      path: abs,
      includeRaw: true,
      exists: existsSync(abs),
      source: context.source
    };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push({ source: context.source, message: 'vault entry must be a string or an object' });
    return null;
  }
  if (raw.enabled === false) return null;
  const rawPath = typeof raw.path === 'string' ? raw.path : '';
  if (rawPath === '') {
    errors.push({ source: context.source, message: 'vault entry is missing path' });
    return null;
  }
  const abs = expandPath(rawPath, context.cwd, context.env);
  const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : path.basename(abs);
  return {
    name,
    path: abs,
    includeRaw: raw.includeRaw !== false,
    exists: existsSync(abs),
    source: context.source
  };
}

function mergeLayer(state, layer, errors) {
  if (!layer || typeof layer !== 'object') return;
  if (layer.vaults !== undefined) {
    if (!Array.isArray(layer.vaults)) {
      errors.push({ source: layer.source, message: 'vaults must be an array' });
    } else {
      if (layer.replaceVaults === true) state.vaults = [];
      for (const raw of layer.vaults) {
        const vault = normalizeVault(raw, { cwd: layer.cwd, env: layer.env, source: layer.source }, errors);
        if (vault === null) continue;
        const index = state.vaults.findIndex((entry) => entry.name.toLowerCase() === vault.name.toLowerCase());
        if (index >= 0) state.vaults[index] = vault;
        else state.vaults.push(vault);
      }
    }
  }
  for (const key of ['indexDir', 'autoIndex', 'refreshSeconds', 'promptSection', 'guardWrites', 'allowNoStem', 'allowAnyMarkdown']) {
    if (layer[key] !== undefined) state[key] = layer[key];
  }
}

export function loadConfig(options) {
  const settings = options || {};
  const cwd = path.resolve(settings.cwd || process.cwd());
  const env = settings.env || process.env;
  const dshHome = expandPath(settings.dshHome || env.DSH_HOME || path.join(os.homedir(), '.dsh'), cwd, env);
  const userFile = path.join(dshHome, 'dsh-wiki.json');
  const projectFile = path.join(cwd, '.dsh-wiki.json');
  const errors = [];
  const sources = [];
  const state = {
    vaults: [],
    indexDir: path.join(dshHome, 'cache', 'dsh-ai-wiki'),
    autoIndex: true,
    refreshSeconds: 5,
    promptSection: true,
    guardWrites: true,
    allowNoStem: false,
    allowAnyMarkdown: false
  };

  if (settings.base && typeof settings.base === 'object') {
    sources.push('cordis');
    mergeLayer(state, Object.assign({ cwd, env, source: 'cordis' }, settings.base), errors);
  }

  if (env.DSH_WIKI_ROOTS !== undefined && String(env.DSH_WIKI_ROOTS).trim() !== '') {
    sources.push('DSH_WIKI_ROOTS');
    mergeLayer(state, {
      cwd,
      env,
      source: 'DSH_WIKI_ROOTS',
      vaults: String(env.DSH_WIKI_ROOTS).split(';').map((item) => item.trim()).filter(Boolean)
    }, errors);
  }
  if (env.DSH_WIKI_INDEX_DIR !== undefined && String(env.DSH_WIKI_INDEX_DIR).trim() !== '') {
    state.indexDir = expandPath(env.DSH_WIKI_INDEX_DIR, cwd, env);
  }

  const user = readJson(userFile);
  if (user.error !== null) errors.push({ source: userFile, message: user.error });
  if (user.data !== null) {
    sources.push(userFile);
    if (user.data.indexDir !== undefined) user.data.indexDir = expandPath(user.data.indexDir, cwd, env);
    mergeLayer(state, Object.assign({ cwd, env, source: userFile }, user.data), errors);
  }

  const project = readJson(projectFile);
  if (project.error !== null) errors.push({ source: projectFile, message: project.error });
  if (project.data !== null) {
    sources.push(projectFile);
    if (project.data.indexDir !== undefined) project.data.indexDir = expandPath(project.data.indexDir, cwd, env);
    mergeLayer(state, Object.assign({ cwd, env, source: projectFile }, project.data), errors);
  }

  if (state.indexDir !== undefined && state.indexDir !== null && state.indexDir !== '') {
    state.indexDir = expandPath(state.indexDir, cwd, env);
  }

  const detected = detectVault(cwd);
  if (detected !== null && !state.vaults.some((entry) => samePath(entry.path, detected))) {
    state.vaults.push({ name: path.basename(detected), path: detected, includeRaw: true, exists: true, source: 'detected' });
    sources.push('detected:' + detected);
  }

  const seen = new Set();
  state.vaults = state.vaults.filter((vault) => {
    const key = vault.name.toLowerCase();
    if (seen.has(key)) {
      errors.push({ source: vault.source, message: 'duplicate vault name: ' + vault.name });
      return false;
    }
    seen.add(key);
    return true;
  });

  state.indexDir = path.resolve(state.indexDir);
  state.errors = errors;
  state.sources = sources;
  state.userFile = userFile;
  state.projectFile = projectFile;
  return state;
}
