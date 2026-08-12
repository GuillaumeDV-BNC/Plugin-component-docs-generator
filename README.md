# Component Docs Generator

A Figma plugin that automatically generates structured documentation pages for your design system components.

## What it does

Component Docs Generator takes your existing Figma components and creates comprehensive, ready-to-use documentation pages — complete with overview descriptions, usage guidelines, variant showcases, behavioral props, and do/don't examples.

## Data Sources

The plugin fetches Markdown (`.md`) files directly from your GitHub repository — such as component READMEs, usage docs, or API references — and uses their content to generate the documentation pages on your Figma canvas. This means your documentation in code stays the single source of truth, and the plugin translates it into visual, browsable design system pages.

> **Note:** A GitHub personal access token is required to use this plugin. You'll need to configure your token in the plugin settings to allow it to fetch `.md` files from your repositories.

## Generated Sections

Each documentation page follows a consistent template layout:

- **Overview** — A summary of the component's purpose and when to use it
- **Component Status** — Displays the current status of the component (e.g. `Stable`, `Beta`, `Deprecated`) so teams can quickly assess maturity and readiness for production use
- **Design System Link** — A direct reference to the component in your design system library, making it easy to navigate between the documentation and the source component
- **Usage Guidelines** — Do's and don'ts for proper implementation
- **Appearances & Variants** — Visual examples of all available variants (sizes, states, styles)
- **Behavioral Props** — Documentation of interactive and configurable properties

## Why use it

Maintaining component documentation by hand is tedious and falls out of date quickly. This plugin bridges the gap between your component library, your codebase, and its documentation — generating polished, navigable doc pages directly inside your Figma file so your design system stays well-documented as it evolves.

## How it works

1. Connect your GitHub account by providing a personal access token
2. Select the component(s) you want to document
3. Run the plugin
4. The plugin fetches relevant `.md` files from your GitHub repo
5. A full documentation page is generated on your canvas with status badges, design system links, and all sourced content
