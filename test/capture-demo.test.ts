// The README's GIF as a script, held to the part of #313 a frame delay cannot show: that it
// walks through the app and not only the map. The pacing is asserted on the file itself, in
// readme.test.ts; this file holds the order it is taken in and the recipe ffmpeg is handed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { STORYBOARD, concatList } from '../scripts/capture-demo.ts';

test('the demo GIF visits the table, the map, its replay and the curves, in that order', () => {
  const pages = STORYBOARD.filter((s) => s.kind === 'still').map((s) => s.path);
  assert.deepEqual([...new Set(pages)], ['/', '/map', '/history']);
  const firstScrub = STORYBOARD.findIndex((s) => s.kind === 'scrub');
  assert.ok(firstScrub > 0, 'the replay is not in the GIF');
  const before = STORYBOARD[firstScrub - 1];
  assert.ok(before.kind === 'still' && before.path === '/map', 'the replay must start from the live map');
});

test('every still the GIF stops on is held long enough to read', () => {
  for (const s of STORYBOARD) if (s.kind === 'still') assert.ok(s.hold >= 2, `${s.path} held ${s.hold}s`);
});

// The concat demuxer drops the duration of the last entry unless the file is listed once more
// after it, so a GIF built without the repeat ends on a frame that flashes past.
test('the ffmpeg recipe holds every frame for its own time, the last one included', () => {
  const list = concatList([
    { file: '/tmp/a.png', seconds: 3 },
    { file: '/tmp/b.png', seconds: 0.25 },
  ]);
  assert.equal(
    list,
    "ffconcat version 1.0\nfile '/tmp/a.png'\nduration 3\nfile '/tmp/b.png'\nduration 0.25\nfile '/tmp/b.png'\n",
  );
});
