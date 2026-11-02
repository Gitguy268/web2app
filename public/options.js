// The Pake flags this form may set. Imported by server.js (to build the real
// command) and by the page (to show it), so the two can never disagree.
export const FLAGS = {
  name: { flag: '--name', type: 'text', label: 'App name', max: 60, required: true },
  width: { flag: '--width', type: 'int', label: 'Width', min: 200, max: 7680, default: 1200 },
  height: { flag: '--height', type: 'int', label: 'Height', min: 200, max: 4320, default: 780 },
  zoom: { flag: '--zoom', type: 'int', label: 'Zoom', min: 50, max: 200, default: 100 },
  minWidth: { flag: '--min-width', type: 'int', label: 'Minimum width', min: 0, max: 7680, default: 0 },
  minHeight: { flag: '--min-height', type: 'int', label: 'Minimum height', min: 0, max: 4320, default: 0 },
  hideTitleBar: { flag: '--hide-title-bar', type: 'bool' },
  fullscreen: { flag: '--fullscreen', type: 'bool' },
  maximize: { flag: '--maximize', type: 'bool' },
  alwaysOnTop: { flag: '--always-on-top', type: 'bool' },
  darkMode: { flag: '--dark-mode', type: 'bool' },
  showSystemTray: { flag: '--show-system-tray', type: 'bool' },
  enableFind: { flag: '--enable-find', type: 'bool' },
  incognito: { flag: '--incognito', type: 'bool' },
  newWindow: { flag: '--new-window', type: 'bool' },
  forceInternalNavigation: { flag: '--force-internal-navigation', type: 'bool' },
  multiArch: { flag: '--multi-arch', type: 'bool' },
  debug: { flag: '--debug', type: 'bool' },
  userAgent: { flag: '--user-agent', type: 'text', label: 'User agent', max: 400 },
  safeDomain: { flag: '--safe-domain', type: 'text', label: 'Domains kept inside the app', max: 400 },
  activationShortcut: { flag: '--activation-shortcut', type: 'text', label: 'Shortcut', max: 40 },
  appVersion: { flag: '--app-version', type: 'text', label: 'Version', max: 20, pattern: /^\d+\.\d+\.\d+$/, default: '1.0.0' },
  output: {
    type: 'choice',
    label: 'Result',
    default: 'dmg',
    choices: { dmg: [], app: ['--targets=app'], install: ['--install'] },
  },
};

// Returns the argument list for `pake`, or throws an Error whose message is
// shown to the person as is. `target` is a web address, or { path } for a
// folder of local files that the server already wrote. Values always use
// --flag=value so a value that starts with "-" can never be read as another flag.
export function toArgs(target, values) {
  const args = [typeof target === 'object' && target ? String(target.path) : checkUrl(target)];
  for (const [key, spec] of Object.entries(FLAGS)) {
    const raw = values[key];
    if (spec.type === 'bool') {
      if (raw === true) args.push(spec.flag);
      continue;
    }
    const value = typeof raw === 'string' ? raw.trim() : raw;
    if (value === undefined || value === null || value === '') {
      if (spec.required) throw new Error(`${spec.label} is needed.`);
      continue;
    }
    if (spec.type === 'int') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < spec.min || n > spec.max) {
        throw new Error(`${spec.label} has to be a whole number from ${spec.min} to ${spec.max}.`);
      }
      if (n !== spec.default) args.push(`${spec.flag}=${n}`);
    } else if (spec.type === 'choice') {
      if (!Object.hasOwn(spec.choices, value)) throw new Error(`${spec.label} "${value}" isn't an option.`);
      args.push(...spec.choices[value]);
    } else {
      if (typeof value !== 'string' || value.length > spec.max || /[\0-\x1f]/.test(value)) {
        throw new Error(`${spec.label} can be at most ${spec.max} characters on one line.`);
      }
      if (spec.pattern && !spec.pattern.test(value)) throw new Error(`${spec.label} looks like 1.0.0.`);
      if (value !== spec.default) args.push(`${spec.flag}=${value}`);
    }
  }
  return args;
}

function checkUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url).trim());
  } catch {
    throw new Error('Enter the full web address, like https://example.com.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('The address has to start with http:// or https://.');
  }
  return parsed.href;
}

// How the same build looks when typed in Terminal.
export function toCommand(args) {
  const quote = (a) => (/^[\w@%+=:,./-]*$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
  return ['pake', ...args.map((a) => a.replace(/^(--[\w-]+=)?(.*)$/s, (_, flag = '', value) => flag + quote(value)))].join(' ');
}
