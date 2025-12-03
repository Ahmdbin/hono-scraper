import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { JSDOM, VirtualConsole } from 'jsdom'
import axios from 'axios'

// تعريف التطبيق
const app = new Hono()

// --- بداية كود الـ Scraper (تم تحويله ليعمل داخل الكلاس) ---

class VideoLinkExtractor {
    config: { timeout: number; userAgent: string }

    constructor() {
        this.config = {
            timeout: 5000,
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36'
        };
    }

    async fetchHtml(url: string) {
        try {
            const res = await axios.get(url, {
                headers: { 'User-Agent': this.config.userAgent },
                timeout: this.config.timeout,
                responseType: 'text'
            });
            return res.data;
        } catch (e: any) {
            throw new Error(`NetErr: ${e.message}`);
        }
    }

    async extractFromPlayerUrl(playerUrl: string) {
        let dom: JSDOM | null = null;
        try {
            // 1. تحميل الـ HTML
            let html = await this.fetchHtml(playerUrl);

            // 2. محاولة استخراج الرابط فوراً (Plan A)
            const rawMatch = html.match(/https?:\/\/[^\s"']+\.m3u8[^\s"']*/);
            if (rawMatch) {
                return rawMatch[0].replace(/\\/g, '');
            }

            // 3. تنظيف HTML
            html = html
                .replace(/<link[^>]*>/g, '')
                .replace(/<style[\s\S]*?<\/style>/g, '')
                .replace(/<img[^>]*>/g, '')
                .replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/g, '')
                .replace(/<script[^>]*src=["'](?!.*(jquery|player|fasel)).*?["'][^>]*><\/script>/g, '');

            const virtualConsole = new VirtualConsole(); // صامت

            // إعداد JSDOM
            dom = new JSDOM(html, {
                url: playerUrl,
                runScripts: "dangerously",
                resources: "usable",
                virtualConsole,
                beforeParse(window: any) {
                    window.__foundM3u8 = null;
                    
                    // دوال وهمية لتخفيف الحمل
                    window.console.log = () => {}; 
                    window.console.warn = () => {};
                    window.console.error = () => {};
                    
                    // محاكاة jwplayer
                    window.jwplayer = () => ({
                        setup: (cfg: any) => {
                            if (cfg.file && cfg.file.includes('.m3u8')) window.__foundM3u8 = cfg.file;
                            else if (cfg.playlist?.[0]?.file) window.__foundM3u8 = cfg.playlist[0].file;
                            return { on: () => {} };
                        },
                        on: () => {}
                    });
                }
            });

            // 4. حلقة فحص
            for (let i = 0; i < 30; i++) {
                const win = dom.window as any;
                if (win.__foundM3u8) {
                    return win.__foundM3u8;
                }
                
                if (win.player_config && win.player_config.file) {
                    return win.player_config.file;
                }

                const docHtml = win.document.documentElement.innerHTML;
                const dynamicMatch = docHtml.match(/https?:\/\/[^\s"']+\.m3u8[^\s"']*/);
                if (dynamicMatch) return dynamicMatch[0];

                await new Promise(r => setTimeout(r, 50));
            }
            
            return null;

        } catch (err) {
            console.error('Extraction Error:', err);
            return null;
        } finally {
            if (dom) try { dom.window.close(); } catch(e) {}
        }
    }
}

// --- نهاية كود الـ Scraper ---

// الصفحة الرئيسية للتأكد أن السيرفر يعمل
app.get('/', (c) => {
  return c.text('Hono Scraper is running on Termux! Use /extract?url=YOUR_URL')
})

// نقطة النهاية (Endpoint) لاستخراج الرابط
app.get('/extract', async (c) => {
    const url = c.req.query('url');

    if (!url) {
        return c.json({ error: 'Please provide a url parameter' }, 400);
    }

    if (!url.startsWith('http')) {
        return c.json({ error: 'Invalid URL format' }, 400);
    }

    const extractor = new VideoLinkExtractor();
    const start = Date.now();
    const masterLink = await extractor.extractFromPlayerUrl(url);
    const duration = ((Date.now() - start) / 1000).toFixed(2);

    if (masterLink) {
        const cleanLink = masterLink.replace(/["',\\].*/, '');
        return c.json({
            success: true,
            url: cleanLink,
            time: `${duration}s`
        });
    } else {
        return c.json({
            success: false,
            error: 'Failed to extract link',
            time: `${duration}s`
        }, 404);
    }
})

// تشغيل السيرفر على المنفذ 3000
const port = 3000
console.log(`Server is running on http://localhost:${port}`)

serve({
  fetch: app.fetch,
  port
})
