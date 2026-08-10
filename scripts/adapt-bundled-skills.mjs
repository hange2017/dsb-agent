#!/usr/bin/env node
/**
 * Adapt MIT upstream skills into DSBAgent-owned bundled skills.
 * Sources: obra/superpowers, addyosmani/agent-skills (both MIT).
 *
 * Usage:
 *   node scripts/adapt-bundled-skills.mjs /tmp/sp-src /tmp/as-src
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const outRoot = path.join(repoRoot, "skills");

const kHeader = (sourceName, upstreamSkill) =>
  [
    "<!--",
    `  DSBAgent bundled skill (adapted).`,
    `  Inspired by ${sourceName} skill "${upstreamSkill}" (MIT).`,
    `  Copyright (c) 2026 ZhaoNingHan — adapted for DSBAgent / .dsb conventions.`,
    `  Upstream MIT copyrights retained in skills/_notices/.`,
    "-->",
    "",
  ].join("\n");

function walkFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(p));
    else out.push(p);
  }
  return out;
}

function adaptText(text, opts) {
  let s = text;
  const reps = [
    [/using-superpowers/gi, "using-dsb-skills"],
    [/using-agent-skills/gi, "using-dsb-skills"],
    [/Superpowers/g, "DSBAgent skills"],
    [/superpowers/g, "dsb-skills"],
    [/Claude Code/g, "DSBAgent"],
    [/Claude\.ai/g, "DSBAgent"],
    [/\.claude\//g, ".dsb/"],
    [/CLAUDE\.md/g, "DSB.md"],
    [/~\/\.claude/g, "~/.dsb"],
    [/docs\/superpowers\/plans/g, ".dsb/plans"],
    [/docs\/superpowers\/specs/g, ".dsb/specs"],
    [/addyosmani\/agent-skills/gi, "DSBAgent bundled skills"],
    [/agent-skills@addy/gi, "dsb-skills"],
  ];
  for (const [re, to] of reps) s = s.replace(re, to);

  // Frontmatter name → dest folder name
  s = s.replace(/^---\n([\s\S]*?)\n---/, (block) => {
    let fm = block;
    if (/^name:\s*/m.test(fm)) {
      fm = fm.replace(/^name:\s*.*$/m, `name: ${opts.destName}`);
    } else {
      fm = fm.replace(/^---/, `---\nname: ${opts.destName}`);
    }
    if (!/^license:/m.test(fm)) {
      fm = fm.replace(/\n---\s*$/, `\nlicense: MIT-derived (see skills/_notices)\n---`);
    }
    return fm;
  });

  if (!s.includes("DSBAgent bundled skill")) {
    // insert header after frontmatter
    const m = s.match(/^---\n[\s\S]*?\n---\n?/);
    if (m) {
      s = m[0] + "\n" + kHeader(opts.sourceLabel, opts.upstreamName) + s.slice(m[0].length);
    } else {
      s = kHeader(opts.sourceLabel, opts.upstreamName) + s;
    }
  }
  return s;
}

function copySkill(srcSkillDir, destName, sourceLabel, upstreamName) {
  const destDir = path.join(outRoot, destName);
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });

  for (const file of walkFiles(srcSkillDir)) {
    const rel = path.relative(srcSkillDir, file);
    const dest = path.join(destDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const ext = path.extname(file).toLowerCase();
    if ([".md", ".txt", ".js", ".cjs", ".ts", ".sh", ".html", ".dot", ".yml", ".yaml", ".json"].includes(ext) || path.basename(file) === "SKILL.md") {
      const raw = fs.readFileSync(file, "utf8");
      const adapted =
        path.basename(file) === "SKILL.md" || ext === ".md"
          ? adaptText(raw, { destName, sourceLabel, upstreamName })
          : raw;
      fs.writeFileSync(dest, adapted);
    } else {
      fs.copyFileSync(file, dest);
    }
  }
}

function main() {
  const spRoot = process.argv[2];
  const asRoot = process.argv[3];
  if (!spRoot || !asRoot) {
    console.error("Usage: node scripts/adapt-bundled-skills.mjs <superpowers-repo> <agent-skills-repo>");
    process.exit(1);
  }

  fs.mkdirSync(outRoot, { recursive: true });
  const notices = path.join(outRoot, "_notices");
  fs.mkdirSync(notices, { recursive: true });
  fs.copyFileSync(path.join(spRoot, "LICENSE"), path.join(notices, "LICENSE-obra-superpowers.txt"));
  fs.copyFileSync(path.join(asRoot, "LICENSE"), path.join(notices, "LICENSE-addyosmani-agent-skills.txt"));
  fs.writeFileSync(
    path.join(notices, "NOTICE.md"),
    [
      "# Third-party skill provenance",
      "",
      "Bundled skills under `skills/sp-*` and `skills/as-*` are **adapted** from:",
      "",
      "- [obra/superpowers](https://github.com/obra/superpowers) — MIT, Copyright (c) 2025 Jesse Vincent",
      "- [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) — MIT, Copyright (c) 2025 Addy Osmani",
      "",
      "Adaptations for DSBAgent: naming, `.dsb/` paths, product references, and meta-skill `using-dsb-skills`.",
      "Original MIT licenses are copied alongside this NOTICE.",
      "",
    ].join("\n"),
  );

  const spSkills = path.join(spRoot, "skills");
  for (const name of fs.readdirSync(spSkills)) {
    const src = path.join(spSkills, name);
    if (!fs.statSync(src).isDirectory()) continue;
    if (!fs.existsSync(path.join(src, "SKILL.md"))) continue;
    const destName = name === "using-superpowers" ? "using-dsb-skills" : `sp-${name}`;
    // using-dsb-skills: prefer SP meta as base; may merge later
    if (name === "using-superpowers") {
      copySkill(src, "using-dsb-skills", "obra/superpowers", name);
    } else {
      copySkill(src, destName, "obra/superpowers", name);
    }
    console.log("sp →", destName);
  }

  const asSkills = path.join(asRoot, "skills");
  for (const name of fs.readdirSync(asSkills)) {
    const src = path.join(asSkills, name);
    if (!fs.statSync(src).isDirectory()) continue;
    if (!fs.existsSync(path.join(src, "SKILL.md"))) continue;
    if (name === "using-agent-skills") {
      // fold into using-dsb-skills appendix instead of duplicate meta
      const appendix = fs.readFileSync(path.join(src, "SKILL.md"), "utf8");
      const dest = path.join(outRoot, "using-dsb-skills", "SKILL.md");
      const adapted = adaptText(appendix, {
        destName: "using-dsb-skills",
        sourceLabel: "addyosmani/agent-skills",
        upstreamName: name,
      });
      fs.appendFileSync(
        dest,
        "\n\n---\n\n## Appendix: engineering skill pack usage (adapted)\n\n" +
          adapted.replace(/^---[\s\S]*?---\n?/, ""),
      );
      console.log("as → merged into using-dsb-skills");
      continue;
    }
    const destName = `as-${name}`;
    copySkill(src, destName, "addyosmani/agent-skills", name);
    console.log("as →", destName);
  }

  // Ensure using-dsb-skills description mentions both packs
  const metaPath = path.join(outRoot, "using-dsb-skills", "SKILL.md");
  if (fs.existsSync(metaPath)) {
    let meta = fs.readFileSync(metaPath, "utf8");
    meta = meta.replace(
      /^description:\s*.*$/m,
      'description: "Use at the start of work in DSBAgent — how to find and apply bundled skills (process pack sp-* and engineering pack as-*). Prefer invoking a matching skill before implementing."',
    );
    fs.writeFileSync(metaPath, meta);
  }

  const count = fs.readdirSync(outRoot).filter((n) => n !== "_notices" && fs.existsSync(path.join(outRoot, n, "SKILL.md"))).length;
  console.log(`Done. ${count} skill dirs in ${outRoot}`);
}

main();
