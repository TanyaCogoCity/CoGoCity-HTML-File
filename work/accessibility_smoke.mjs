import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('/Users/tanyalipovich/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const routes = [
  '#/',
  '#/students',
  '#/community',
  '#/jobs',
  '#/blog',
  '#/faq-safety-legal',
  '#/about-us',
  '#/privacy-policy',
  '#/accessibility',
];

const browser = await chromium.launch({
  headless: true,
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const results = [];

for (const route of routes) {
  await page.goto(`http://127.0.0.1:4177/${route}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);
  const result = await page.evaluate(() => {
    const visible = el => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const h1s = Array.from(document.querySelectorAll('main h1')).filter(visible);
    const headings = Array.from(document.querySelectorAll('main h1, main h2, main h3, main h4, main h5, main h6')).filter(visible).map(h => ({
      level: Number(h.tagName.slice(1)),
      text: h.textContent.trim().slice(0, 80),
    }));
    const skippedHeadings = [];
    for (let i = 1; i < headings.length; i += 1) {
      if (headings[i].level > headings[i - 1].level + 1) skippedHeadings.push(`${headings[i - 1].text} -> ${headings[i].text}`);
    }
    const imagesMissingAlt = Array.from(document.querySelectorAll('img')).filter(img => !img.hasAttribute('alt')).length;
    const unlabeledButtons = Array.from(document.querySelectorAll('button')).filter(button => {
      const text = button.textContent.trim();
      const label = button.getAttribute('aria-label') || button.getAttribute('title');
      return visible(button) && !text && !label;
    }).length;
    const fieldsMissingLabels = Array.from(document.querySelectorAll('input:not([type="hidden"]), textarea, select')).filter(field => {
      if (!visible(field)) return false;
      const id = field.id;
      const hasLabel = id && document.querySelector(`label[for="${CSS.escape(id)}"]`);
      const wrapped = field.closest('label');
      const aria = field.getAttribute('aria-label') || field.getAttribute('aria-labelledby');
      return !hasLabel && !wrapped && !aria;
    }).length;
    const main = document.querySelector('main');
    const skip = document.querySelector('.skip-link');
    const focusOutline = window.getComputedStyle(document.documentElement).getPropertyValue('--color-primary');
    return {
      title: document.title,
      h1Count: h1s.length,
      h1Text: h1s.map(h => h.textContent.trim()),
      headingCount: headings.length,
      skippedHeadings,
      imagesMissingAlt,
      unlabeledButtons,
      fieldsMissingLabels,
      hasMain: !!main,
      mainTabIndex: main?.getAttribute('tabindex') || '',
      hasSkipLink: !!skip,
      focusColor: focusOutline.trim(),
    };
  });
  results.push({ route, ...result });
}

await browser.close();

let failures = 0;
for (const result of results) {
  const issues = [];
  if (!result.hasMain) issues.push('missing main');
  if (result.mainTabIndex !== '-1') issues.push('main is not focusable');
  if (!result.hasSkipLink) issues.push('missing skip link');
  if (result.h1Count !== 1) issues.push(`expected 1 H1, found ${result.h1Count}`);
  if (result.skippedHeadings.length) issues.push(`skipped headings: ${result.skippedHeadings.join('; ')}`);
  if (result.imagesMissingAlt) issues.push(`${result.imagesMissingAlt} images missing alt`);
  if (result.unlabeledButtons) issues.push(`${result.unlabeledButtons} unlabeled buttons`);
  if (result.fieldsMissingLabels) issues.push(`${result.fieldsMissingLabels} fields missing labels`);
  if (issues.length) failures += 1;
  console.log(`\n${result.route}`);
  console.log(`  title: ${result.title}`);
  console.log(`  h1: ${result.h1Text.join(' | ') || '(none)'}`);
  console.log(`  issues: ${issues.length ? issues.join(', ') : 'none'}`);
}

if (failures) {
  console.error(`\nAccessibility smoke found issues on ${failures} route(s).`);
  process.exit(1);
}
console.log('\nAccessibility smoke passed.');
