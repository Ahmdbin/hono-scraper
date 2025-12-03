import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { handle } from 'hono/vercel'
import { JSDOM, VirtualConsole } from 'jsdom'
import axios from 'axios'

// تعريف التطبيق
const app = new Hono().basePath('/api') 
// ملاحظة: أضفنا basePath لتنظيم الروابط، لكن يمكن إزالته إذا كنت تفضل الروابط المباشرة
// إذا أبقيته، الرابط سيصبح: /api/extract
// إذا حذفته، الرابط سيصبح: /extract (وهو الأفضل إذا كنت تستخدم Vercel rewrites)

const finalApp = new Hono() // تطبيق نظيف بدون BasePath للتحكم الكامل

// --- بداية كود الـ Scraper ---

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

            // 3. تنظيف HTML لتسريع المعالجة
            html = html
                .replace(/<link[^>]*>/g, '')
                .replace(/<style[\s\S]*?<\/style>/g, '')
                .replace(/<img[^>]*>/g, '')
                .replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/g, '')
                .replace(/<script[^>]*src=["'](?!.*(jquery|player|fasel)).*?["'][^>]*><\/script>/g, '');

            const virtualConsole = new VirtualConsole(); // منع ظهور أي لوجات في الكونسول

            // إعداد JSDOM
            dom = new JSDOM(html, {
                url: playerUrl,
                runScripts: "dangerously", // ضروري لتشغيل JS الموقع
                resources: "usable",
                virtualConsole,
                beforeParse(window: any) {
                    window.__foundM3u8 = null;
                    
                    // تعطيل الوظائف الثقيلة
                    window.console.log = () => {}; 
                    window.console.warn = () => {};
                    window.console.error = () => {};
                    
                    // محاكاة jwplayer لصيد الرابط
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

            // 4. حلقة فحص سريعة
            for (let i = 0; i < 30; i++) { // فحص لمدة 1.5 ثانية كحد أقصى
                const win = dom.window as any;
                
                // فحص المتغير الذي زرعناه
                if (win.__foundM3u8) {
                    return win.__foundM3u8;
                }
                
                // فحص متغيرات شائعة أخرى
                if (win.player_config && win.player_config.file) {
                    return win.player_config.file;
                }

                // فحص DOM في حال تمت الكتابة فيه
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

// الصفحة الرئيسية
finalApp.get('/', (c) => {
  return c.text('Hono Scraper is running! Use /extract?url=YOUR_URL')
})

// نقطة النهاية (Endpoint)
finalApp.get('/extract', async (c) => {
    const url = c.req.query('url');

    if (!url) {
        return c.json({ error: 'Please provide a url parameter' }, 400);
    }

    if (!url.startsWith('http')) {
        return c.json({ error: 'Invalid URL format' }, 400);
    }

    const extractor = new VideoLinkExtractor();
    const start = Date.now();
    
    // تشغيل عملية الاستخراج
    const masterLink = await extractor.extractFromPlayerUrl(url);
    
    const duration = ((Date.now() - start) / 1000).toFixed(2);

    if (masterLink) {
        // تنظيف الرابط
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

// --- منطق التشغيل المزدوج (Local vs Vercel) ---

// التحقق من البيئة
const isVercel = process.env.VERCEL === '1';

if (!isVercel) {
    // هذا الكود يعمل فقط على Termux أو الجهاز المحلي
    const port = 3000
    console.log(`Server is running on http://localhost:${port}`)
    
    serve({
      fetch: finalApp.fetch,
      port
    })
}

// هذا التصدير هو ما يبحث عنه Vercel
export default handle(finalApp)
