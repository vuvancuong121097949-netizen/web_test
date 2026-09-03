const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const outputDir = path.join(projectRoot, 'dist');
const publicFiles = ['index.html', 'app.js', 'style.css', '_redirects'];

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });

for (const filename of publicFiles) {
    const source = path.join(projectRoot, filename);
    if (!fs.existsSync(source)) throw new Error(`Thiếu tệp công khai bắt buộc: ${filename}`);
    fs.copyFileSync(source, path.join(outputDir, filename));
}

const assetsSource = path.join(projectRoot, 'assets');
if (fs.existsSync(assetsSource)) {
    fs.cpSync(assetsSource, path.join(outputDir, 'assets'), { recursive: true });
}

console.log(`Đã chuẩn bị ${outputDir} chỉ với các tệp website công khai.`);
