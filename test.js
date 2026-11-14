// Tests for lib.js: `node test.js` (matching), `node test.js --live` also
// reads a real YouTube search page the way the refill does.
'use strict';
const assert = require('assert');
const { serumMatcher, serumExtractInitialData, serumParseVideos } = require('./lib.js');

const m = serumMatcher(['business', 'tech', 'rust', 'c++'], ['prank']);
assert.strictEqual(m.decide('Rust 1.80 is out | No Boilerplate').verdict, 'show');
assert.strictEqual(m.decide('RUST in 100 seconds').verdict, 'show', 'case-insensitive');
assert.strictEqual(m.decide('Why I trust nobody').verdict, 'hide', '"trust" is not "rust"');
assert.strictEqual(m.decide('Learning C++ in a weekend').verdict, 'show', 'symbols in a keyword');
assert.strictEqual(m.decide('Funny cats compilation').verdict, 'hide');
assert.strictEqual(m.decide('Tech prank gone wrong').verdict, 'hide', 'the blocklist wins');
assert.strictEqual(m.decide('Business and tech news').score, 2);
assert.strictEqual(serumMatcher([], []).decide('anything').verdict, 'show', 'no keywords hides nothing');
assert.strictEqual(serumMatcher([], ['prank']).decide('a prank').verdict, 'hide');

const page = '<script>var ytInitialData = {"a":[{"videoRenderer":{"videoId":"abcdefghijk","title":{"runs":[{"text":"Rust "},{"text":"tips"}]},"ownerText":{"runs":[{"text":"Chan"}]},"lengthText":{"simpleText":"9:59"}}}]};</script>';
const v = serumParseVideos(serumExtractInitialData(page));
assert.deepStrictEqual([v.length, v[0].id, v[0].title, v[0].channel, v[0].length], [1, 'abcdefghijk', 'Rust tips', 'Chan', '9:59']);
assert.strictEqual(serumExtractInitialData('<html>no data</html>'), null);
console.log('lib.js: all tests pass');

if (process.argv.includes('--live')) {
  (async () => {
    const res = await fetch('https://www.youtube.com/results?search_query=rust', { headers: { 'accept-language': 'en' } });
    const videos = serumParseVideos(serumExtractInitialData(await res.text()));
    assert.ok(videos.length > 0, 'no videos found on a real search page');
    console.log(`live: ${videos.length} videos read from a real search page, e.g.:`);
    for (const x of videos.slice(0, 5)) console.log(`  ${x.id}  ${x.title}  (${x.channel}, ${x.length})`);
  })().catch(e => {
    console.error(e.message);
    process.exit(1);
  });
}
