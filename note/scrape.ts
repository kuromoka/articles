import puppeteer from 'puppeteer';
import TurndownService from 'turndown';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BASE_URL = 'https://note.com/kuromoka';
const OUTPUT_DIR = path.join(__dirname, 'articles');

if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

const turndownService = new TurndownService();

// Note.com specific turndown rules (optional)
turndownService.addRule('remove-scripts', {
    filter: ['script', 'style'],
    replacement: () => ''
});

async function main() {
    const args = process.argv.slice(2);
    const targetUrls: string[] = [];
    const targetQueries: string[] = [];

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--url' && i + 1 < args.length) {
            targetUrls.push(args[++i]);
        } else if (args[i].startsWith('http')) {
            targetUrls.push(args[i]);
        } else {
            targetQueries.push(args[i]);
        }
    }

    const browser = await puppeteer.launch({
        headless: true,
    });
    const page = await browser.newPage();

    let articles: { url: string, title: string }[] = [];

    if (targetUrls.length > 0) {
        console.log(`Processing ${targetUrls.length} specified URLs...`);
        articles = targetUrls.map(url => ({ url, title: 'URL Target' }));
    } else {
        console.log(`Navigating to ${BASE_URL}...`);
        await page.goto(BASE_URL, { waitUntil: 'networkidle2' });

        // 1. Click "もっとみる" (Load more) until all articles are loaded
        console.log('Loading articles...');
        let hasMore = true;
        while (hasMore) {
            const btnData = await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button'));
                const btn = buttons.find(b => b.textContent?.includes('もっとみる'));
                if (btn) {
                    btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    return { found: true };
                }
                return { found: false };
            });

            if (btnData.found) {
                console.log('Clicking "Load more"...');
                await page.evaluate(() => {
                    const buttons = Array.from(document.querySelectorAll('button'));
                    const btn = buttons.find(b => b.textContent?.includes('もっとみる'));
                    (btn as HTMLButtonElement)?.click();
                });
                await new Promise(resolve => setTimeout(resolve, 3000));
            } else {
                hasMore = false;
            }
        }

        // 2. Extract article URLs and Titles
        const allArticles = await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a[href^="https://note.com/kuromoka/n/"]')) as HTMLAnchorElement[];
            const seen = new Set();
            const results: { url: string, title: string }[] = [];
            for (const link of links) {
                const url = link.href;
                if (seen.has(url)) continue;
                seen.add(url);

                // Get title from aria-label or title attribute or text content
                const title = link.getAttribute('aria-label') || link.getAttribute('title') || link.textContent?.trim() || 'Untitled';
                results.push({ url, title });
            }
            return results;
        });

        if (targetQueries.length > 0) {
            articles = allArticles.filter(a =>
                targetQueries.some(q => a.title.includes(q) || a.url.includes(q))
            );
            console.log(`Filtered to ${articles.length} articles matching queries.`);
        } else {
            articles = allArticles;
            console.log(`Found ${articles.length} articles.`);
        }
    }


    // Get list of existing files to skip duplicates
    const existingFiles = fs.readdirSync(OUTPUT_DIR);

    // 3. Process each article
    for (const article of articles) {
        const { url, title } = article;
        const safeTitle = title.replace(/[\\/:*?"<>|]/g, '_');

        // Optimistic skip check: check if any existing file ends with this title
        // Only skip if title is not dummy 'URL Target'
        if (title !== 'URL Target') {
            const isExists = existingFiles.some(f => f.endsWith(`_${safeTitle}.md`));
            if (isExists) {
                console.log(`Skipping (already exists by title): ${safeTitle}`);
                continue;
            }
        }

        try {
            console.log(`Processing: ${url}`);
            await page.goto(url, { waitUntil: 'networkidle2' });

            // Wait for the article content to appear
            await page.waitForSelector('article', { timeout: 10000 }).catch(() => console.log('Timeout waiting for article tag'));

            const data = await page.evaluate(() => {
                const titleSelector = 'h1.o-noteContentHeader__title, h1.m-noteHeader__title, .fn-note-title';
                const innerTitle = document.querySelector(titleSelector)?.textContent?.trim() || 'Untitled';

                // Find date by looking for patterns in the header area or all text
                const bodyText = document.body.innerText;
                const dateMatch = bodyText.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);

                let dateStr = '00000000';
                if (dateMatch) {
                    const year = dateMatch[1];
                    const month = dateMatch[2].padStart(2, '0');
                    const day = dateMatch[3].padStart(2, '0');
                    dateStr = `${year}${month}${day}`;
                }

                const contentSelector = 'div.o-noteContentText, div.m-noteBody, .fn-note-body';
                const contentHtml = document.querySelector(contentSelector)?.innerHTML || '';

                return { title: innerTitle, dateStr, contentHtml };
            });

            if (data.contentHtml === '') {
                console.warn(`Warning: No content found for ${url}`);
            }

            const finalSafeTitle = data.title.replace(/[\\/:*?"<>|]/g, '_');
            const filename = `${data.dateStr}_${finalSafeTitle}.md`;
            const filepath = path.join(OUTPUT_DIR, filename);

            if (fs.existsSync(filepath)) {
                console.log(`Skipping (already exists by full filename): ${filename}`);
                continue;
            }

            const markdown = turndownService.turndown(data.contentHtml);
            const fileContent = `# ${data.title}\n\n${markdown}`;
            fs.writeFileSync(filepath, fileContent);
            console.log(`Saved: ${filename}`);
        } catch (err) {
            console.error(`Failed to process ${url}:`, err);
        }

    }

    await browser.close();
    console.log('Finished!');
}


main().catch(console.error);
