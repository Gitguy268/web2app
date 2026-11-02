import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toArgs, toCommand } from '../public/options.js';

test('defaults add nothing but url and name', () => {
  assert.deepEqual(toArgs('https://example.com', { name: 'Ex', width: '1200', zoom: 100, output: 'dmg' }), [
    'https://example.com/',
    '--name=Ex',
  ]);
});

test('flags, numbers and output choice', () => {
  const args = toArgs('https://music.youtube.com', {
    name: 'YouTube Music',
    width: '1400',
    hideTitleBar: true,
    darkMode: 'true', // only a real boolean switches a flag on
    output: 'install',
  });
  assert.deepEqual(args, [
    'https://music.youtube.com/',
    '--name=YouTube Music',
    '--width=1400',
    '--hide-title-bar',
    '--install',
  ]);
  assert.equal(toCommand(args), "pake https://music.youtube.com/ --name='YouTube Music' --width=1400 --hide-title-bar --install");
});

test('local folder target', () => {
  const args = toArgs({ path: './site' }, { name: 'My Notes', output: 'app' });
  assert.deepEqual(args, ['./site', '--name=My Notes', '--targets=app']);
  assert.equal(toCommand([...args, '--inject=inject.css,inject.js']), "pake ./site --name='My Notes' --targets=app --inject=inject.css,inject.js");
});

test('rejects bad input', () => {
  assert.throws(() => toArgs('file:///etc/passwd', { name: 'x' }), /http/);
  assert.throws(() => toArgs('not a url', { name: 'x' }), /full web address/);
  assert.throws(() => toArgs('https://a.b', {}), /App name is needed/);
  assert.throws(() => toArgs('https://a.b', { name: 'x', zoom: 300 }), /Zoom/);
  assert.throws(() => toArgs('https://a.b', { name: 'x', output: 'toString' }), /isn't an option/);
  assert.throws(() => toArgs('https://a.b', { name: 'a\nb' }), /one line/);
  assert.throws(() => toArgs('https://a.b', { name: 'x', appVersion: '1.0' }), /1\.0\.0/);
});
