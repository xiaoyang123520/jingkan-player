'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const repo = process.argv[2];
if (!repo || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(repo)) {
  console.error('用法：node scripts/configure-release.cjs GitHub用户名/仓库名');
  process.exit(1);
}
const [owner, name] = repo.split('/');
const filename = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(filename, 'utf8'));
pkg.repository = { type: 'git', url: `https://github.com/${repo}.git` };
pkg.homepage = `https://github.com/${repo}#readme`;
pkg.bugs = { url: `https://github.com/${repo}/issues` };
pkg.build.publish = [{ provider: 'github', owner, repo: name, releaseType: 'release' }];
fs.writeFileSync(filename, JSON.stringify(pkg, null, 2) + '\n');
console.log(`发布目标已写入本地配置：${repo}。尚未创建仓库或上传文件；必须重新构建安装包。`);
