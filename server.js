// -*- coding: utf-8 -*-
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const JSON_FILE = path.join(__dirname, 'noobai_data.json');
const IMAGE_DIR = 'X:\\image\\artist_style_test_20260526';

/**
 * 加载 JSON 中的所有画师列表
 */
function loadArtists() {
    try {
        if (!fs.existsSync(JSON_FILE)) return [];
        const content = fs.readFileSync(JSON_FILE, 'utf-8');
        const data = JSON.parse(content);
        return data.artists || [];
    } catch (e) {
        console.error("Error reading JSON file:", e);
        return [];
    }
}

/**
 * 扫描已生成的物理图片前缀
 */
function scanGeneratedImages() {
    const generated = new Map();
    try {
        if (!fs.existsSync(IMAGE_DIR)) return generated;
        const files = fs.readdirSync(IMAGE_DIR);
        files.forEach(file => {
            if (file.endsWith('.png')) {
                const match = file.match(/^(\d+)_(.*?)(?:_result.*)?\.png$/i);
                if (match) {
                    const idx = parseInt(match[1], 10);
                    generated.set(idx, file);
                }
            }
        });
    } catch (e) {
        console.error("Error scanning images directory:", e);
    }
    return generated;
}

/**
 * 处理 API /api/artists 路由
 */
function handleApiArtists(res) {
    const artists = loadArtists();
    const generatedMap = scanGeneratedImages();
    
    const result = artists.map((artist, index) => {
        const idx = index + 1;
        const filename = generatedMap.get(idx) || null;
        return {
            index: idx,
            name: artist.name,
            generated: !!filename,
            filename: filename
        };
    });
    
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result));
}

/**
 * 托管物理盘符中的图片文件
 */
function handleStaticImage(urlPath, res) {
    let decodeUrl = urlPath;
    try {
        decodeUrl = decodeURIComponent(urlPath);
    } catch (e) {
        console.warn("[WARNING] URI decode failed, falling back to raw path:", urlPath);
    }
    let filename = decodeUrl.replace('/images/', '');
    let filepath;
    const YOGA_DIR = 'X:\\image\\yoga_style_guide_20260527';
    if (filename.startsWith('yoga/')) {
        filename = filename.replace('yoga/', '');
        filepath = path.join(YOGA_DIR, filename);
    } else if (filename.startsWith('thumbs/')) {
        filename = filename.replace('thumbs/', '');
        filepath = path.join(IMAGE_DIR, 'thumbnails', filename);
    } else {
        filepath = path.join(IMAGE_DIR, filename);
    }
    
    // 安全验证防止跨目录越界漏洞
    if (!filepath.startsWith(IMAGE_DIR) && !filepath.startsWith(YOGA_DIR)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end("Forbidden");
    }
    
    if (fs.existsSync(filepath)) {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        fs.createReadStream(filepath).pipe(res);
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end("Image Not Found");
    }
}

/**
 * 静态分发处理器
 */
const server = http.createServer((req, res) => {
    const { url } = req;
    
    if (url === '/' || url === '/index.html') {
        const htmlPath = path.join(__dirname, 'index.html');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        fs.createReadStream(htmlPath).pipe(res);
    } else if (url === '/api/artists') {
        handleApiArtists(res);
    } else if (url.startsWith('/images/')) {
        handleStaticImage(url, res);
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end("Not Found");
    }
});

server.listen(PORT, () => {
    console.log(`============================================================`);
    console.log(`1025 Artist Gallery Server running at http://localhost:${PORT}`);
    console.log(`Scanning target physical path: ${IMAGE_DIR}`);
    console.log(`============================================================`);
});
