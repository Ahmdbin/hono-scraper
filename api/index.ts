import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { handle } from 'hono/vercel'
import { JSDOM, VirtualConsole } from 'jsdom'
import axios from 'axios'

// 1. إنشاء تطبيق واحد فقط بدون BasePath معقد
const app = new Hono()

// 2. معالجة الأخطاء لتجنب الانهيار الكامل (500 Internal Server Error)
app.onError((err, c) => {
    console.error('App Error:', err)
    return c.json({
        success: false,
        error: err.message,
        stack: err.stack
    }, 500)
})

// 3. كلاس السحب (Scraper)
class VideoLinkExtractor {
    config: { timeout: number; userAgent: string }

    constructor() {
        this.config = {
            timeout: 8000, // زيادة الوقت قليلاً لبيئة السيرفر
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
            throw new Error(`Connection Error: ${e.message}`);
        }
    }

    async extractFromPlayerUrl(playerUrl: string) {
        let dom: JSDOM | null = null;
        try {
            let html = await this.fetchHtml(playerUrl);

            // Plan A: Regex مباشر
            const rawMatch = html.match(/https?:\/\/[^\s"']+\.m3u8[^\s"']*/);
            if (rawMatch) return rawMatch[0].replace(/\\/g, '');

            // Plan B: JSDOM
            // تنظيف الصفحة لتسريع المعالجة وتوفير الذاكرة
            html = html
                .replace(/<link[^>]*>/g, '')
                .replace(/<style[\s\S]*?<\/style>/g, '')
                .replace(/<img[^>]*>/g, '')
                .replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/g, '')
                .replace(/<script[^>]*src=["'](?!.*(jquery|player|fasel)).*?["'][^>]*><\/script>/g, '');

            const virtualConsole = new VirtualConsole();
            
            dom = new JSDOM(html, {
                url: playerUrl,
                runScripts: "dangerously",
                resources: "usable",
                virtualConsole,
                beforeParse(window: any) {
                    window.__foundM3u8 = null;
                    window.console.log = () => {}; 
                    window.console.warn = () => {};
                    window.console.error = () => {};
                    
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

            // انتظار النتيجة (بحد أقصى 2.5 ثانية)
            for (let i = 0; i < 50; i++) {
                const win = dom.window as any;
                if (win.__foundM3u8) return win.__foundM3u8;
                if (win.player_config && win.player_config.file) return win.player_config.file;
                
                const docHtml = win.document.documentElement.innerHTML;
                const dynamicMatch = docHtml.match(/https?:\/\/[^\s"']+\.m3u8[^\s"']*/);
                if (dynamicMatch) return dynamicMatch[0];

                await new Promise(r => setTimeout(r, 50));
            }
            
            return null;

        } catch (err: any) {
            console.error('Extractor Error:', err.message);
            return null;
        } finally {
            if (dom) try { dom.window.close(); } catch(e) {}
        }
    }
}

// 4. تعريف دالة المعالجة الرئيسية (لإعادة استخدامها)
const handleExtraction = async (c: any) => {
    const url = c.req.query('url');

    if (!url) return c.json({ error: 'Please provide a url parameter' }, 400);
    if (!url.startsWith('http')) return c.json({ error: 'Invalid URL' }, 400);

    try {
        const extractor = new VideoLinkExtractor();
        const start = Date.now();
        const masterLink = await extractor.extractFromPlayerUrl(url);
        const duration = ((Date.now() - start) / 1000).toFixed(2);

        if (masterLink) {
            return c.json({
                success: true,
                url: masterLink.replace(/["',\\].*/, ''),
                time: `${duration}s`
            });
        } else {
            return c.json({
                success: false,
                error: 'Link not found',
                time: `${duration}s`
            }, 404);
        }
    } catch (e: any) {
        return c.json({ success: false, error: e.message }, 500);
    }
};

// 5. تسجيل المسارات (Routing)
// هام: نسجل المسار مرتين لضمان عمله سواء أضاف Vercel البادئة /api أم لا
app.get('/', (c) => c.text('Hono Scraper is Ready! 🚀'))
app.get('/api', (c) => c.text('Hono Scraper is Ready! 🚀'))

app.get('/extract', handleExtraction)
app.get('/api/extract', handleExtraction) // احتياطياً

// 6. التصدير والتشغيل
const isVercel = process.env.VERCEL === '1';

if (!isVercel) {
    const port = 3000
    console.log(`Server is running on http://localhost:${port}`)
    serve({ fetch: app.fetch, port })
}

export default handle(app)
