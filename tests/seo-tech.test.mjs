import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const robots = readFileSync(resolve(root, 'robots.txt'), 'utf8');
const sitemap = readFileSync(resolve(root, 'sitemap.xml'), 'utf8');

const TITLE = 'The Skylark — Private Event Venue in Benton, LA';
const META =
  'Private event venue in Benton, LA for parties, showers, and celebrations up to 50 guests. Bar setup (BYOB), seating, and games. Close to Shreveport and Bossier.';
const LEDE =
  'The Skylark is a private space for parties, showers, and celebrations for up to 50 guests — a fully equipped bar area (BYOB), plenty of seating, and games.';
const ADDED =
  'A short drive from Shreveport and Bossier City. Same Benton spot — up to 50 guests, bar setup (BYOB), seating, and games.';

function jsonLdBlocks(source) {
  return [...source.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(
    (match) => JSON.parse(match[1]),
  );
}

test('robots.txt allows the marketing site and points at the sitemap', () => {
  assert.match(robots, /User-agent:\s*\*/);
  assert.match(robots, /Allow:\s*\//);
  assert.doesNotMatch(robots, /Disallow:\s*\//);
  assert.match(robots, /Sitemap:\s*https:\/\/www\.skylarkbenton\.com\/sitemap\.xml/);
});

test('sitemap.xml lists only existing public pages', () => {
  assert.match(sitemap, /<loc>https:\/\/www\.skylarkbenton\.com\/<\/loc>/);
  assert.match(sitemap, /<loc>https:\/\/www\.skylarkbenton\.com\/terms\.html<\/loc>/);
  assert.doesNotMatch(sitemap, /agreement\.html/);
  assert.doesNotMatch(sitemap, /approve\.html/);
});

test('homepage keeps approved title, meta, H1, and both lede sentences', () => {
  assert.match(html, new RegExp(`<title>${TITLE.replace(/[—]/g, '—')}<\\/title>`));
  assert.match(html, new RegExp(`<meta name="description" content="${META.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}">`));
  assert.match(html, /<h1>Private Event Venue<br>Benton, Louisiana<\/h1>/);
  assert.match(html, new RegExp(LEDE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(html, new RegExp(ADDED.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(html, /Skylark Manor/);
  assert.match(html, /\$350 \/ \$500/);
  assert.match(html, /118 5th St Ste 2C, Benton, LA 71006/);
  assert.match(html, /tel:3183445001/);
});

test('homepage has canonical and Open Graph tags using approved copy', () => {
  assert.match(html, /<link rel="canonical" href="https:\/\/www\.skylarkbenton\.com\/">/);
  assert.match(html, new RegExp(`<meta property="og:title" content="${TITLE}">`));
  assert.match(html, new RegExp(`<meta property="og:description" content="${META.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}">`));
  assert.match(html, /<meta property="og:url" content="https:\/\/www\.skylarkbenton\.com\/">/);
  assert.match(html, /<meta property="og:type" content="website">/);
  assert.match(html, /<meta property="og:image" content="https:\/\/www\.skylarkbenton\.com\/photos\/1\.jpg">/);
});

test('homepage keeps FAQ schema and adds EventVenue + LocalBusiness JSON-LD', () => {
  const blocks = jsonLdBlocks(html);
  const faq = blocks.find((block) => block['@type'] === 'FAQPage');
  const venue = blocks.find((block) => {
    const types = Array.isArray(block['@type']) ? block['@type'] : [block['@type']];
    return types.includes('EventVenue') && types.includes('LocalBusiness');
  });

  assert.ok(faq, 'FAQPage schema is missing');
  assert.equal(faq.mainEntity.length, 10);
  assert.ok(venue, 'EventVenue + LocalBusiness schema is missing');
  assert.equal(venue.name, 'The Skylark');
  assert.equal(venue.description, META);
  assert.equal(venue.url, 'https://www.skylarkbenton.com/');
  assert.equal(venue.telephone, '+13183445001');
  assert.equal(venue.address.streetAddress, '118 5th St Ste 2C');
  assert.equal(venue.address.addressLocality, 'Benton');
  assert.equal(venue.address.addressRegion, 'LA');
  assert.equal(venue.address.postalCode, '71006');
  assert.equal(venue.maximumAttendeeCapacity, 50);
  assert.equal(venue.openingHoursSpecification.opens, '12:00');
  assert.equal(venue.openingHoursSpecification.closes, '00:00');
  assert.deepEqual(venue.sameAs, ['https://www.instagram.com/theskylarkbenton/']);
});
