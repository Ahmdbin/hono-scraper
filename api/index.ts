import { serve } from '@hono/node-server'
import { getRequestListener } from '@hono/node-server' // <--- استيراد جديد ومهم
import { Hono } from 'hono'
import { JSDOM, VirtualConsole } from 'jsdom'
import axios from 'axios'

const app = new Hono()

// معالجة الأخطاء العامة
app.onError((err, c) => {
    console.error('App Error:', err)
    return c.json({
        success: false,
        error: err.message,
    }, 500)
})

// كلاس السحب (بدون تغييرات جوهرية)
class VideoLinkExtractor {
    config: { timeout: number; userAgent: string }

    constructor() {
        this.config = {
            timeout: 9000, 
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

            const rawMatch = html.match(/https?:\/\/[^\s"']+\.m3u8[^\s"']*/);
            if (rawMatch) return rawMatch[0].replace(/\\/g, '');

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

            for (let i = 0; i < 40; i++) {
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

// Handler function
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

// تعريف المسارات
app.get('/', (c) => c.text('Hono Scraper is Ready! (Node Mode) 🚀'))
app.get('/extract', handleExtraction)

// --- الجزء المهم جداً للتصحيح ---

const isVercel = process.env.VERCEL === '1';

if (isVercel) {
    // الطريقة الصحيحة لبيئة Node على Vercel
    // نحول التطبيق إلى RequestListener (req, res) تقليدي
    export default getRequestListener(app.fetch)
} else {
    // الطريقة المحلية على Termux
    const port = 3000
    console.log(`Server is running on http://localhost:${port}`)
    serve({
        fetch: app.fetch,
        port
    })
}
