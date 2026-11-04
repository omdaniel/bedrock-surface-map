import { defineConfig } from 'vitepress';

const pagesUrl = process.env.DOCS_SITE_URL;
const base = process.env.DOCS_BASE_PATH || (pagesUrl ? new URL(pagesUrl).pathname.replace(/\/?$/, '/') : '/');
if (!base.startsWith('/') || !base.endsWith('/') || base.includes('..')) throw new Error('Docs base must be an absolute URL path with a trailing slash.');
const doc = (text: string, file: string) => ({ text, link: `/docs/${file}` });

export default defineConfig({
  title: 'Bedrock Surface Map',
  description: 'Explore your Bedrock world in the browser. Start with a demo, install a map, or contribute to the project.',
  srcDir: '.generated',
  base,
  cleanUrls: false,
  lastUpdated: false,
  ignoreDeadLinks: false,
  sitemap: pagesUrl ? { hostname: new URL(base, pagesUrl).href } : undefined,
  head: [['meta', { name: 'theme-color', content: '#244b3b' }]],
  themeConfig: {
    siteTitle: 'Bedrock Surface Map',
    nav: [
      { text: 'Start here', link: '/start' },
      { text: 'Use the map', link: '/docs/USER-GUIDE' },
      { text: 'Contribute', link: '/CONTRIBUTING' },
      { text: 'Demo', link: 'https://omdaniel.github.io/bedrock-surface-map/demo/' },
    ],
    search: { provider: 'local' },
    outline: [2, 3],
    socialLinks: [{ icon: 'github', link: 'https://github.com/omdaniel/bedrock-surface-map' }],
    editLink: {
      pattern: (page) => `https://github.com/omdaniel/bedrock-surface-map/edit/main/${page.filePath.includes('/') || ['CONTRIBUTING.md', 'THIRD_PARTY.md'].includes(page.filePath) ? page.filePath : `website/pages/${page.filePath}`}`,
      text: 'Edit this page on GitHub',
    },
    sidebar: [
      { text: 'Welcome', items: [{ text: 'Choose your path', link: '/start' }, doc('Map controls & players', 'USER-GUIDE'), doc('Compatibility & troubleshooting', 'COMPATIBILITY')] },
      { text: 'Install your map', items: [doc('Snapshot viewer', 'INSTALL'), doc('Prepare a world export', 'WORLD-EXPORT'), doc('Download the live bundle', 'OPERATOR-INSTALL'), doc('Existing Docker Bedrock server', 'QUICKSTART-BDS'), doc('Crafty & AMP', 'PANELS'), doc('HTTPS deployment', 'DEPLOYMENT')] },
      { text: 'Configure & operate', collapsed: true, items: [doc('Configuration', 'CONFIGURATION'), doc('Player tracking', 'TRACKING'), doc('Terrain synchronization', 'TERRAIN-SYNC'), doc('Connection acceptance', 'TERRAIN-ACCEPTANCE')] },
      { text: 'Contribute', items: [{ text: 'Contribution guide', link: '/CONTRIBUTING' }, doc('Source setup', 'GETTING_STARTED'), doc('Architecture & local checks', 'DEVELOPMENT'), doc('Website development', 'WEBSITE')] },
      { text: 'Technical reference', collapsed: true, items: [doc('Surface format & renderer', 'FORMAT'), doc('Appearance', 'APPEARANCE'), doc('Snapshot import', 'IMPORT'), doc('Tracking protocol', 'TRACKING-REFERENCE'), doc('Verification & limits', 'VERIFICATION'), doc('Visual comparison', 'VISUAL-COMPARISON'), doc('Public demo', 'PUBLIC_DEMO'), doc('Release CI', 'CI'), { text: 'Deployment reference', link: '/deploy/README' }, { text: 'Firewall reference', link: '/deploy/FIREWALL' }, { text: 'Licenses & notices', link: '/THIRD_PARTY' }] },
    ],
    footer: {
      message: 'AGPL-3.0-only · Not an official Minecraft product. Not associated with Mojang or Microsoft.',
      copyright: 'Copyright © 2026 Oliver M Daniel',
    },
  },
});
