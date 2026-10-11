# Skill Coach

A Claude Code mod. Before each prompt is sent, it:

1. Finds the skills you have installed that fit your request.
2. Finds plugins you could install that would help (from your marketplaces and the plugin directory).
3. Offers a clearer prompt that names those skills. You choose what happens next.

## What you see

When a skill fits, or your prompt could be clearer, a dialog shows the new prompt:

- **Edit it first**: the new prompt goes into the prompt box. Change it, then press Enter.
- **Send it now**: sends the new prompt.
- **Send mine**: sends what you typed.
- **Other**: type your own version.

When only a plugin to install would help, nothing stops you. Your prompt is sent as typed, and a note in the chat says which plugin and how to install it. Each plugin is named once per session.

Example:

```
You type:    make a bar chart of monthly sales from sales.csv in excel
New prompt:  make a bar chart of monthly sales from sales.csv in excel

             Use the `xlsx` skill.
```

## What it skips

- Short replies like "yes", "ok" or "go ahead", and prompts under 15 characters.
- Slash commands, `!` shell commands and `#` notes.
- Prompts typed while Claude is still working.
- Prompts with pasted images (so the images are never lost).
- The prompt you send right after choosing **Edit it first**.

## Install

You need Claude Code 2.1.287 or newer.

1. Unzip this folder somewhere you will keep it, for example your Documents folder. Claude Code reads the mod from this folder, so don't delete it.
2. In a terminal, run:

   ```
   claude plugin marketplace add ~/Documents/skill-coach
   claude plugin install skill-coach@skill-coach
   ```

3. Start a new Claude Code session. In a session that is already open, run `/reload-plugins`.

It works in the terminal and in the Code tab of the Claude desktop app.

## Commands and settings

- `/skill-coach`: shows whether it is on, and how many skills and plugins it knows.
- `/skill-coach off` and `/skill-coach on`: turn the check off or on. This is remembered.
- `/skill-coach refresh`: reloads your skills and the plugin list, for example after you install a plugin.

In `/config`, the Skill Coach rows set:

- **Model**: `haiku` (default, fastest), `sonnet` or `opus`.
- **Suggest plugins to install**: on by default.
- **Shortest prompt to check**: 15 characters by default.

## Cost and privacy

- Each check is one small model call through your own Claude Code login. It usually takes 1 to 3 seconds and uses a little of your plan.
- It sends the prompt, the last few messages of the chat, your project folder's name, and the names and descriptions of your skills. Nothing goes to any other service.
- It runs `claude plugin list --available --json` once per session to learn which plugins you could install. If that command is not found, it reads Claude Code's own plugin files instead.
- Plugins it suggests are not checked by this mod. Read about a plugin before you install it.
