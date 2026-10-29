#!/usr/bin/env node
/**
 * scan.mjs — deskshell 生态冷启动：候选开发者侦察。
 *
 * 目标：用 GitHub Search API 找“可能对 deskshell 有用”的真实人与真实仓库，
 * 产出一份今天就能照着发消息的名单（candidates.json / candidates.csv）。
 *
 * 硬约束：
 *  - Node >= 22，只用原生 fetch，零第三方依赖（与 deskshell 主仓库一致）。
 *  - 数据只能来自 API 实际返回；取不到就留空字符串，不猜测。
 *  - 每次请求间隔 >= 1s；搜索接口是独立配额（30 req/min），因此单独放宽到 2200ms。
 *  - 403/429 时按 X-RateLimit-Reset / Retry-After 等待后重试。
 *
 * 用法：
 *   GITHUB_TOKEN=ghp_xxx node deskshell/outreach/scan.mjs
 *   node deskshell/outreach/scan.mjs            # 依次尝试 GITHUB_TOKEN / GH_TOKEN / gh auth token / dsh 本地配置
 *
 * 可选环境变量：
 *   OUTREACH_MAX_CANDIDATES=120   # 最终候选人数上限（默认 120）
 *   OUTREACH_MAX_REPOS=40         # 拉 contributor 的仓库数上限（默认 40）
 *   OUTREACH_STAR_MIN=10          # 仓库 star 下限（默认 10）
 *   OUTREACH_DRY_RUN=1            # 只打印查询计划，不发请求
 */

import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const API = 'https://api.github.com';
const HERE = dirname(fileURLToPath(import.meta.url));
const SELF_AUTHOR = 'ciceroyang';           // 本仓库作者，排除
const SELF_REPO = 'ciceroyang/deskshell';   // 本仓库，排除

const LIMITS = {
  searchMinGapMs: 2200,     // 搜索接口 30 req/min
  coreMinGapMs: 1100,       // 核心接口 5000 req/h，保守 1s
  maxPagesPerQuery: 2,
  maxReposForContributors: Number(process.env.OUTREACH_MAX_REPOS || 40),
  maxCandidates: Number(process.env.OUTREACH_MAX_CANDIDATES || 120),
  maxContributorsPerRepo: 10,
  starMin: Number(process.env.OUTREACH_STAR_MIN || 10),
};

// 优先画像：20-2000 star 且近 90 天有提交
const PRIORITY = { starMin: 20, starMax: 2000, recentDays: 90 };

/* ------------------------------------------------------------------ */
/* 查询面                                                              */
/* ------------------------------------------------------------------ */

// 仓库检索：topic 面 + 关键词面，覆盖 deskshell 的驱动/录制器/skill/MCP 四个贡献面
const REPO_QUERIES = [
  { q: 'topic:computer-use', pages: 2, note: '同类主题：computer-use 智能体' },
  { q: 'topic:desktop-automation', pages: 2, note: '桌面自动化' },
  { q: 'topic:uia', pages: 1, note: 'Windows UI Automation' },
  { q: 'topic:accessibility language:typescript', pages: 1, note: '无障碍 + TS' },
  { q: 'topic:agent topic:gui', pages: 1, note: 'GUI 智能体' },
  { q: 'topic:mcp desktop', pages: 1, note: 'MCP 桌面包' },
  { q: 'computer use agent', pages: 1, note: '关键词：computer use agent' },
  { q: 'desktop agent', pages: 1, note: '关键词：desktop agent' },
  { q: 'screen automation', pages: 1, note: '关键词：screen automation' },
  { q: 'pywinauto', pages: 1, note: 'Python Windows 自动化生态' },
  { q: 'at-spi2', pages: 1, note: 'Linux AT-SPI2（roadmap 缺口）' },
  { q: 'accessibility automation', pages: 1, note: '关键词：accessibility automation' },
  { q: 'windows automation cli', pages: 1, note: '关键词：windows automation cli' },
  { q: 'mcp server screenshot', pages: 1, note: '截图类 MCP server' },
  { q: 'ui automation llm', pages: 1, note: '关键词：ui automation llm' },
  // 补充面（驱动/录制器/协议相邻）
  { q: 'topic:computer-use-control', pages: 1, note: '补充：computer-use-control' },
  { q: 'topic:gui-automation', pages: 1, note: '补充：gui-automation' },
  { q: 'topic:screen-capture agent', pages: 1, note: '补充：截屏 + agent' },
  { q: 'macos accessibility automation', pages: 1, note: '补充：macOS AX' },
  { q: 'topic:rpa agent', pages: 1, note: '补充：RPA + agent' },
];

// 用户检索：bio / 名称里的自述，用来捞“人和仓库都还没红”的个体开发者
const USER_QUERIES = [
  { q: 'computer-use in:bio', note: 'bio: computer-use' },
  { q: 'desktop automation in:bio', note: 'bio: desktop automation' },
  { q: 'accessibility automation in:bio', note: 'bio: accessibility automation' },
  { q: 'uia automation in:bio', note: 'bio: uia automation' },
  { q: 'pywinauto in:bio', note: 'bio: pywinauto' },
];

/* ------------------------------------------------------------------ */
/* token                                                               */
/* ------------------------------------------------------------------ */

async function readDshSettingsToken() {
  const candidates = [
    join(homedir(), '.dsh', 'storages', 'dsh-github', 'settings.json'),
  ];
  for (const p of candidates) {
    try {
      const raw = await readFile(p, 'utf8');
      const json = JSON.parse(raw);
      if (typeof json.token === 'string' && json.token.trim()) {
        return { token: json.token.trim(), source: 'dsh local settings (~/.dsh/storages/dsh-github/settings.json)' };
      }
    } catch {
      /* 忽略，继续下一个来源 */
    }
  }
  return null;
}

async function resolveToken() {
  const envToken = (process.env.GITHUB_TOKEN || '').trim();
  if (envToken) return { token: envToken, source: 'env:GITHUB_TOKEN' };

  const envGh = (process.env.GH_TOKEN || '').trim();
  if (envGh) return { token: envGh, source: 'env:GH_TOKEN' };

  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token'], { timeout: 8000 });
    const t = stdout.trim();
    if (t) return { token: t, source: 'gh auth token' };
  } catch {
    /* gh 未安装或未登录 */
  }

  const local = await readDshSettingsToken();
  if (local) return local;

  return null;
}

/* ------------------------------------------------------------------ */
/* 限速的 fetch                                                        */
/* ------------------------------------------------------------------ */

let requestCount = 0;
let lastRequestAt = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gate(minGapMs) {
  const wait = lastRequestAt + minGapMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

class UnavailableError extends Error {}

function makeClient(token) {
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: 'Bearer ' + token,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'deskshell-outreach-scout',
  };

  async function gh(path, { minGapMs = LIMITS.coreMinGapMs, retries = 6, quiet = false } = {}) {
    const url = path.startsWith('http') ? path : API + path;
    for (let attempt = 1; attempt <= retries; attempt++) {
      await gate(minGapMs);
      requestCount += 1;

      let res;
      try {
        res = await fetch(url, { headers });
      } catch (err) {
        if (attempt === retries) throw err;
        if (!quiet) console.log('  ! network error (' + err.message + '), retry in 5s');
        await sleep(5000);
        continue;
      }

      if (res.ok) {
        const json = await res.json();
        return { json, headers: res.headers };
      }

      const status = res.status;
      const bodyText = await res.text();

      if (status === 403 || status === 429) {
        // “列表太大/滥用检测”不是配额问题，直接跳过
        if (/too large|abuse detection|blocked from accessing/i.test(bodyText) && !/rate limit/i.test(bodyText)) {
          throw new UnavailableError(bodyText.slice(0, 160));
        }
        const remaining = res.headers.get('x-ratelimit-remaining');
        const reset = Number(res.headers.get('x-ratelimit-reset') || 0);
        const retryAfter = Number(res.headers.get('retry-after') || 0);
        let waitMs;
        if (retryAfter > 0) waitMs = retryAfter * 1000 + 1000;
        else if (remaining === '0' && reset > 0) waitMs = Math.max(1000, reset * 1000 - Date.now() + 2000);
        else waitMs = 60000;
        waitMs = Math.min(waitMs, 300000);
        if (!quiet) {
          console.log('  ! ' + status + ' rate-limited (remaining=' + remaining + '), sleep ' + Math.round(waitMs / 1000) + 's [attempt ' + attempt + ']');
        }
        await sleep(waitMs);
        continue;
      }

      if (status === 404 || status === 422) {
        throw new UnavailableError(status + ' ' + bodyText.slice(0, 120));
      }
      throw new Error(status + ' ' + url + ' :: ' + bodyText.slice(0, 200));
    }
    throw new Error('exhausted retries: ' + url);
  }

  return { gh, headers };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

const isBot = (u) => {
  if (!u) return true;
  if (u.type === 'Bot') return true;
  const login = String(u.login || '');
  return /\[bot\]$/i.test(login) || /-bot$/i.test(login) || /^bot-/i.test(login);
};

const daysAgo = (iso) => {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / 86400000;
};

function tierOf(repo) {
  const inRange = repo.stars >= PRIORITY.starMin && repo.stars <= PRIORITY.starMax;
  const recent = daysAgo(repo.pushed_at) <= PRIORITY.recentDays;
  if (inRange && recent) return 0;   // 最想要：小而活
  if (inRange) return 1;             // 小而沉寂
  if (recent) return 2;              // 大而活
  return 3;                          // 大而沉寂
}

function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return '"' + s.replace(/"/g, '""').replace(/\r?\n/g, ' ') + '"';
}

async function main() {
  const resolved = await resolveToken();
  if (!resolved) {
    console.error('未找到 GitHub token。请先导出 GITHUB_TOKEN，或安装并登录 gh CLI：');
    console.error('  PowerShell:  $env:GITHUB_TOKEN="ghp_xxx"');
    console.error('  bash:        export GITHUB_TOKEN=ghp_xxx');
    process.exit(2);
  }
  if (process.env.OUTREACH_DRY_RUN === '1') {
    console.log('dry run: token from ' + resolved.source);
    console.log('repo queries:', REPO_QUERIES.length, '| user queries:', USER_QUERIES.length);
    return;
  }

  const { gh } = makeClient(resolved.token);
  console.log('token: ' + resolved.source);
  console.log('repo queries: ' + REPO_QUERIES.length + ' | user queries: ' + USER_QUERIES.length);

  /** @type {Map<string, any>} full_name -> repo */
  const repos = new Map();

  for (const query of REPO_QUERIES) {
    for (let page = 1; page <= query.pages; page++) {
      const path = '/search/repositories?q=' + encodeURIComponent(query.q) +
        '&sort=stars&order=desc&per_page=100&page=' + page;
      let data;
      try {
        ({ json: data } = await gh(path, { minGapMs: LIMITS.searchMinGapMs }));
      } catch (err) {
        console.log('  ! query failed [' + query.q + ' p' + page + ']: ' + err.message);
        break;
      }
      const items = data.items || [];
      let fresh = 0;
      for (const item of items) {
        if (!item || !item.full_name) continue;
        if (item.fork || item.archived) continue;
        if (item.full_name.toLowerCase() === SELF_REPO) continue;
        if ((item.stargazers_count || 0) < LIMITS.starMin) continue;
        const key = item.full_name.toLowerCase();
        if (repos.has(key)) {
          const prev = repos.get(key);
          if (!prev.matched_queries.includes(query.q)) prev.matched_queries.push(query.q);
          continue;
        }
        fresh += 1;
        repos.set(key, {
          full_name: item.full_name,
          stars: item.stargazers_count || 0,
          description: item.description || '',
          pushed_at: item.pushed_at || '',
          language: item.language || '',
          topics: item.topics || [],
          html_url: item.html_url,
          matched_queries: [query.q],
        });
      }
      console.log('  [' + query.q + ' p' + page + '] ' + items.length + ' hits, ' + fresh + ' new repos');
      if (items.length < 100) break;
    }
  }

  const repoList = [...repos.values()];
  for (const r of repoList) r.tier = tierOf(r);

  console.log('\nrepos: ' + repoList.length + ' (tier0 ' + repoList.filter((r) => r.tier === 0).length +
    ' / tier1 ' + repoList.filter((r) => r.tier === 1).length +
    ' / tier2 ' + repoList.filter((r) => r.tier === 2).length +
    ' / tier3 ' + repoList.filter((r) => r.tier === 3).length + ')');

  // 拉 contributor 的顺序：先“小而活”，再“小而沉寂”，再“大而活”
  const miningOrder = [...repoList].sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.pushed_at !== b.pushed_at) return a.pushed_at < b.pushed_at ? 1 : -1;
    return b.stars - a.stars;
  }).slice(0, LIMITS.maxReposForContributors);

  /** @type {Map<string, any>} login -> candidate */
  const people = new Map();

  for (const repo of miningOrder) {
    let contributors = [];
    try {
      const { json } = await gh('/repos/' + repo.full_name + '/contributors?per_page=30&anon=false');
      contributors = Array.isArray(json) ? json : [];
    } catch (err) {
      console.log('  ! contributors skipped [' + repo.full_name + ']: ' + err.message.slice(0, 80));
      continue;
    }
    const humans = contributors
      .filter((c) => c && c.login && !isBot(c))
      .filter((c) => c.login.toLowerCase() !== SELF_AUTHOR.toLowerCase())
      .sort((a, b) => (b.contributions || 0) - (a.contributions || 0))
      .slice(0, LIMITS.maxContributorsPerRepo);

    for (const c of humans) {
      const login = c.login;
      let entry = people.get(login.toLowerCase());
      if (!entry) {
        entry = {
          login,
          type: c.type || 'User',
          html_url: c.html_url || ('https://github.com/' + login),
          contributions: 0,
          matched_queries: [],
          repos: [],
        };
        people.set(login.toLowerCase(), entry);
      }
      entry.contributions = Math.max(entry.contributions, c.contributions || 0);
      entry.repos.push({
        full_name: repo.full_name,
        stars: repo.stars,
        description: repo.description,
        pushed_at: repo.pushed_at,
        contributions: c.contributions || 0,
      });
      for (const q of repo.matched_queries) {
        if (!entry.matched_queries.includes(q)) entry.matched_queries.push(q);
      }
    }
    console.log('  ok [' + repo.full_name + '] +' + humans.length + ' humans (total ' + people.size + ')');
  }

  // 用户搜索面
  for (const query of USER_QUERIES) {
    let data;
    try {
      ({ json: data } = await gh('/search/users?q=' + encodeURIComponent(query.q) + '&per_page=50', {
        minGapMs: LIMITS.searchMinGapMs,
      }));
    } catch (err) {
      console.log('  ! user query failed [' + query.q + ']: ' + err.message.slice(0, 100));
      continue;
    }
    const items = (data.items || []).slice(0, 25);
    let added = 0;
    for (const u of items) {
      if (!u || !u.login || isBot(u)) continue;
      if (u.login.toLowerCase() === SELF_AUTHOR.toLowerCase()) continue;
      const key = u.login.toLowerCase();
      if (people.has(key)) {
        const entry = people.get(key);
        if (!entry.matched_queries.includes(query.q)) entry.matched_queries.push(query.q);
        continue;
      }
      people.set(key, {
        login: u.login,
        type: u.type || 'User',
        html_url: u.html_url || ('https://github.com/' + u.login),
        contributions: 0,
        matched_queries: [query.q],
        repos: [],
        from_user_search: true,
      });
      added += 1;
    }
    console.log('  [' + query.q + '] ' + items.length + ' users, +' + added + ' new (total ' + people.size + ')');
  }

  // 排名：命中的仓库数 > 贡献数；仓库派生优先于纯用户检索
  const ranked = [...people.values()].sort((a, b) => {
    if (a.repos.length !== b.repos.length) return b.repos.length - a.repos.length;
    if (a.contributions !== b.contributions) return b.contributions - a.contributions;
    return (a.from_user_search ? 1 : 0) - (b.from_user_search ? 1 : 0);
  }).slice(0, LIMITS.maxCandidates);

  console.log('\nenriching ' + ranked.length + ' profiles ...');

  const candidates = [];
  let done = 0;
  for (const person of ranked) {
    done += 1;
    let profile = {};
    try {
      const { json } = await gh('/users/' + encodeURIComponent(person.login));
      profile = json || {};
    } catch (err) {
      console.log('  ! profile skipped [' + person.login + ']: ' + err.message.slice(0, 80));
    }
    if (profile.type === 'Bot' || /\[bot\]$/i.test(person.login)) continue;

    const top = [...person.repos].sort((a, b) => b.stars - a.stars)[0] || null;
    candidates.push({
      login: person.login,
      type: profile.type || person.type || 'User',
      html_url: profile.html_url || person.html_url,
      name: profile.name || '',
      company: profile.company || '',
      location: profile.location || '',
      followers: typeof profile.followers === 'number' ? profile.followers : '',
      public_repos: typeof profile.public_repos === 'number' ? profile.public_repos : '',
      top_repo: top ? top.full_name : '',
      top_repo_stars: top ? top.stars : '',
      top_repo_pushed_at: top ? top.pushed_at : '',
      contributions: person.contributions,
      matched_query: person.matched_queries.join('; '),
      profile_bio: profile.bio || '',
      blog: profile.blog || '',
      twitter: profile.twitter_username || '',
      // 以下为附加字段，便于人工复核（不属于协议要求的字段）
      top_repo_description: top ? top.description : '',
      repos: person.repos
        .sort((a, b) => b.stars - a.stars)
        .map((r) => ({ full_name: r.full_name, stars: r.stars, pushed_at: r.pushed_at, contributions: r.contributions })),
      source: person.from_user_search ? 'user-search' : 'repo-contributors',
    });

    if (done % 20 === 0) console.log('  ... ' + done + '/' + ranked.length);
  }

  // 排序输出：能对上“小而活”仓库的人往前放
  const starOfTop = (c) => (typeof c.top_repo_stars === 'number' ? c.top_repo_stars : 0);
  candidates.sort((a, b) => {
    const aPri = starOfTop(a) >= PRIORITY.starMin && starOfTop(a) <= PRIORITY.starMax ? 1 : 0;
    const bPri = starOfTop(b) >= PRIORITY.starMin && starOfTop(b) <= PRIORITY.starMax ? 1 : 0;
    if (aPri !== bPri) return bPri - aPri;
    if (b.repos.length !== a.repos.length) return b.repos.length - a.repos.length;
    if (starOfTop(b) !== starOfTop(a)) return starOfTop(b) - starOfTop(a);
    return (typeof b.followers === 'number' ? b.followers : 0) - (typeof a.followers === 'number' ? a.followers : 0);
  });

  const generatedAt = new Date().toISOString();
  const payload = {
    meta: {
      generated_at: generatedAt,
      author_excluded: SELF_AUTHOR,
      repo_excluded: SELF_REPO,
      token_source: resolved.source,
      requests: requestCount,
      repo_queries: REPO_QUERIES,
      user_queries: USER_QUERIES,
      filters: {
        star_min: LIMITS.starMin,
        priority_star_range: [PRIORITY.starMin, PRIORITY.starMax],
        priority_recent_days: PRIORITY.recentDays,
        max_repos_mined: LIMITS.maxReposForContributors,
        max_candidates: LIMITS.maxCandidates,
        bots_excluded: true,
      },
      counts: {
        repos: repoList.length,
        candidates: candidates.length,
      },
    },
    repos: repoList
      .sort((a, b) => (a.tier - b.tier) || (b.stars - a.stars))
      .map((r) => ({
        full_name: r.full_name,
        stars: r.stars,
        tier: r.tier,
        pushed_at: r.pushed_at,
        language: r.language,
        description: r.description,
        html_url: r.html_url,
        matched_queries: r.matched_queries,
      })),
    candidates,
  };

  await writeFile(join(HERE, 'candidates.json'), JSON.stringify(payload, null, 2) + '\n', 'utf8');

  const header = [
    'login', 'type', 'html_url', 'name', 'company', 'location', 'followers', 'public_repos',
    'top_repo', 'top_repo_stars', 'top_repo_pushed_at', 'contributions', 'matched_query',
    'profile_bio', 'blog', 'twitter',
  ];
  const lines = ['\uFEFF' + header.map(csvCell).join(',')];
  for (const c of candidates) {
    lines.push(header.map((k) => csvCell(c[k])).join(','));
  }
  await writeFile(join(HERE, 'candidates.csv'), lines.join('\r\n') + '\r\n', 'utf8');

  console.log('\nwrote candidates.json / candidates.csv');
  console.log('repos: ' + repoList.length + ' | candidates: ' + candidates.length + ' | requests: ' + requestCount);
  console.log('\ntop 15:');
  for (const c of candidates.slice(0, 15)) {
    console.log('  ' + c.login.padEnd(24) + ' ' + String(c.followers).padStart(6) + 'f  ' +
      (c.top_repo || '-') + '(' + (c.top_repo_stars || 0) + ')  [' + c.matched_query + ']');
  }
}

main().catch((err) => {
  console.error('scan failed: ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
