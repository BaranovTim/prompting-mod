# Skill Coach

A Claude Code mod. Before each prompt is sent, it:

1. **Researches the model in your window** (what `/model` shows) from Anthropic's own docs: that model's "Prompting Claude …" page and the shared prompting best practices. Kept for 14 days, so this happens once per model.
2. **Reads your prompt** to work out the task and the kind of work it is (`frontend-design`, `debugging`, `data-analysis`, …).
3. **Researches how to prompt for that kind of task**: Claude Code's best practices, its common workflows, the example prompts in its prompt library, and a web search about prompting an agent for that kind of work. Kept for 14 days per kind.
4. **Finds the skills that fit**: the ones you have installed, and reliable ones it finds online (see below).
5. **Combines everything into one rewritten prompt** that follows both guides and names the skills to use.

## Skills found online

Skill Coach searches [skills.sh](https://skills.sh), the public registry of Agent Skills on GitHub, with searches made from your task. A skill counts as reliable only when:

- it has at least 1,000 installs,
- every security audit skills.sh shows for it (Gen Agent Trust Hub, Socket, Snyk) passed, with no warning,
- it lives in a public GitHub repository, and its SKILL.md can be read there.

Installed skills come first; an online skill is picked only where nothing installed covers that part of the work, and never one with the same name as a skill you have.

An online skill does not need installing. The prompt names it (``Use the `frontend-design` skill from anthropics/skills (attached below).``) and its SKILL.md is attached to the prompt for the agent to follow, with a link to its source. You don't see the attachment in the chat; the line in the prompt says it is there.

## What you see

A dialog that shows only the new prompt:

- **Send this prompt**: sends the new prompt, with the SKILL.md of each online skill it names.
- **Edit it first** (terminal only): puts the new prompt in the prompt box. Change it, then press Enter. Online skills you keep in the text are still attached.
- **Send mine**: sends what you typed, with nothing attached.
- **Other**: type your own version. Online skills it names are attached.

The desktop app has no prompt box a mod can fill, so it shows only **Send this prompt** and **Send mine**; type your own version under **Other**.

If your prompt already follows both guides and no skill fits, it is sent as typed and you see nothing.

Example, with Claude Opus 5.5:

```
You type:    build a landing page for my bakery in react with a menu and opening hours
New prompt:  Build a landing page for my bakery in React, with a menu section and the opening hours.
             Done when it renders without console errors and works on a phone; take a screenshot to check.
             Use the `frontend-design` skill from anthropics/skills (attached below).
```

## How long it takes

- A prompt whose model and kind of task are already researched: a few seconds (one quick analysis, the skills search, one rewrite).
- The first prompt with a new model, or a new kind of task: 20 to 60 seconds more, once, while it researches.

## What it skips

- Short replies like "yes", "ok" or "go ahead", and prompts under 15 characters.
- Slash commands, `!` shell commands and `#` notes.
- Prompts typed while Claude is still working.
- Prompts with pasted images (so the images are never lost).
- The prompt you send right after choosing **Edit it first**.

If the model, the docs or the registry cannot be reached, it does without that part; if it cannot write a prompt at all, yours is sent as typed and one line in the chat says why.

## Install

You need Claude Code 2.1.295 or newer.

```
claude plugin marketplace add ~/Desktop/projects/skill-coach
claude plugin install skill-coach@skill-coach
```

After changing the code, update the installed copy:

```
claude plugin marketplace update skill-coach
claude plugin update skill-coach@skill-coach
```

Then start a new session. In a terminal session that is already open, run `/reload-plugins`.

## Commands and settings

- `/skill-coach`: whether it is on, the model in this window and whether it is researched, and the kinds of task researched so far.
- `/skill-coach guide`: the prompting guide for the current model and its sources.
- `/skill-coach guide <kind>`: the guide for one kind of task, such as `/skill-coach guide frontend design`.
- `/skill-coach research`: researches the current model again now, and forgets the task research so each kind is redone when it next comes up.
- `/skill-coach off` and `/skill-coach on`: turn it off or on. This is remembered.

In `/config`, the Skill Coach rows set:

- **Rewriting model**: `sonnet` (default), `haiku` (faster, cheaper) or `opus`. It writes the guides and each rewrite. Reading the task always uses `haiku`.
- **Shortest prompt to check**: 15 characters by default.

## Cost and privacy

- Each prompt is two model calls through your own Claude Code login: a quick one with Haiku to read the task, and the rewrite. Research is one larger call per model and per kind of task, every 14 days.
- The web search for a new kind of task goes through your session's own WebSearch tool, so your permission settings apply: where WebSearch is denied, the research uses the docs alone. Where your settings ask first, you may see a permission prompt the first time.
- It fetches public pages from platform.claude.com, code.claude.com, skills.sh, github.com and raw.githubusercontent.com. What it sends them is the search words for skills (made from your task) and nothing else.
- The rewrite sends the model your prompt, the last few messages of the chat, your project folder's name, the two guides, and the names and descriptions of your skills and of the online skills it found.
- An online skill's SKILL.md is third-party text the agent will follow. The reliability checks above lower the risk; they do not remove it. The prompt names each one and links its source, so you can read it before you send.
