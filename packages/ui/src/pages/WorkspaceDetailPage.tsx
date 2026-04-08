import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { workspaces } from '../services/workspaceService';
import {
  GitBranch, ArrowLeft, RefreshCw, Loader2, Terminal, FileCode,
  Play, Square, ChevronRight, ChevronDown,
  Upload, GitCommit, X, GitPullRequest, FileText,
  Trash2, Save, FilePlus, Plus, SplitSquareHorizontal,
  Settings, ExternalLink, Eye, History, PanelRightOpen, MessageSquare,
} from 'lucide-react';
import { XTerminal } from '../components/workspace/XTerminal';
import { WorkspaceConfigEditor } from '../components/workspace/WorkspaceConfigEditor';
import { EmbeddedChat } from '../components/workspace/EmbeddedChat';
import Editor from '@monaco-editor/react';
import { renderMarkdown } from '../components/chat/ChatMessageList';

// ── VS Code Material Icon Theme ──

const I = ({ d, color, cls }: { d: string; color: string; cls: string }) => (
  <svg viewBox="0 0 24 24" className={`${cls} shrink-0`}><path d={d} fill={color} /></svg>
);

function FileIcon({ name, className = 'w-4 h-4' }: { name: string; className?: string }) {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const base = name.toLowerCase();
  const c = className;

  // ── Special files ──
  if (base === 'package.json') return <I cls={c} color="#8BC34A" d="M12 2L3 7v10l9 5 9-5V7l-9-5zm0 2.2L18.5 7.5 12 11 5.5 7.5 12 4.2zM5 9l6 3.3v7.4L5 16.4V9zm14 0v7.4l-6 3.3v-7.4L19 9z" />;
  if (base === 'tsconfig.json' || base.startsWith('tsconfig')) return <I cls={c} color="#3178C6" d="M3 3h18v18H3V3zm9.3 13.5v-1.8c.5.4 1.2.7 1.9.7.9 0 1.3-.4 1.3-1 0-1.4-3.5-1.4-3.5-3.7 0-1.5 1-2.3 2.5-2.3.6 0 1.2.1 1.6.3v1.7c-.4-.3-1-.5-1.5-.5-.8 0-1.2.3-1.2.9 0 1.3 3.5 1.2 3.5 3.7 0 1.5-1 2.4-2.6 2.4-.7 0-1.4-.1-2-.4zM7 10.2h2V16h1.8v-5.8H13V8.6H7v1.6z" />;
  if (base === '.gitignore' || base === '.gitattributes') return <I cls={c} color="#F05032" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm.06 2.03c2.08 0 3.98.81 5.4 2.13l-1.42 1.42A5.96 5.96 0 0012.06 6c-3.31 0-6 2.69-6 6s2.69 6 6 6c2.43 0 4.5-1.45 5.43-3.53h-4.1v-2h6.53c.1.54.14 1.09.14 1.65 0 4.35-3.52 7.88-7.88 7.88A7.94 7.94 0 014.06 12a7.94 7.94 0 018-7.97z" />;
  if (base === '.env' || base.startsWith('.env.')) return <I cls={c} color="#ECD53F" d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-1 6h2v2h-2V7zm0 4h2v6h-2v-6z" />;
  if (base === 'dockerfile' || base.startsWith('docker')) return <I cls={c} color="#2496ED" d="M13 4h-2v2h2V4zm-3 0H8v2h2V4zm-3 0H5v2h2V4zm9 0h-2v2h2V4zm-3 3h-2v2h2V7zm-3 0H8v2h2V7zm-3 0H5v2h2V7zm-3 0H2v2h2V7zm9-3h-2v2h2V4zM3 10c0 4 2.5 7.7 6.2 9.3.4.2.8-.2.7-.6C9.3 16.7 8 15 8 13c0-1.7.7-3.2 1.8-4.3L3 10zm18 .3c-.8-.8-2.1-1-3.2-.6C16 8.2 14.1 7 12 7c-3.3 0-6 2.7-6 6 0 2.5 1.5 4.6 3.7 5.5C11.3 19.4 13 20 15 20c2.5 0 4.6-1.3 5.7-3.2.5-1 .3-2.3-.7-3.2l-2-2V10l3 .3z" />;
  if (base.includes('eslint')) return <I cls={c} color="#4B32C3" d="M12 2L2 7.5V16.5L12 22l10-5.5V7.5L12 2zm0 3.3l6.2 3.4L12 12.1 5.8 8.7 12 5.3zm-7 5l6 3.3v6.1l-6-3.3v-6.1zm8 9.4v-6.1l6-3.3v6.1l-6 3.3z" />;
  if (base.includes('prettier')) return <I cls={c} color="#56B3B4" d="M5 5h2v2H5V5zm4 0h2v2H9V5zm4 0h2v2h-2V5zm4 0h2v2h-2V5zM5 9h2v2H5V9zm4 0h2v2H9V9zm4 0h2v2h-2V9zM5 13h2v2H5v-2zm4 0h2v2H9v-2zm4 0h2v2h-2v-2zM5 17h2v2H5v-2zm4 0h2v2H9v-2z" />;
  if (base.includes('vite')) return <I cls={c} color="#BD34FE" d="M18.8 2.4L12.4 21l-1.2-.5 5-14.5L7.6 9l-.5-1.2L17.5 2l1.3.4zM5 3.6l1.2.5-5 14.5 8.6-3 .5 1.2L.3 22.6 5 3.6z" />;
  if (base.includes('tailwind')) return <I cls={c} color="#38BDF8" d="M12 6C9.33 6 7.67 7.33 7 10c1-1.33 2.17-1.83 3.5-1.5.76.19 1.3.74 1.91 1.35C13.4 10.84 14.5 12 17 12c2.67 0 4.33-1.33 5-4-1 1.33-2.17 1.83-3.5 1.5-.76-.19-1.3-.74-1.91-1.35C15.6 7.16 14.5 6 12 6zM7 12c-2.67 0-4.33 1.33-5 4 1-1.33 2.17-1.83 3.5-1.5.76.19 1.3.74 1.91 1.35C8.4 16.84 9.5 18 12 18c2.67 0 4.33-1.33 5-4-1 1.33-2.17 1.83-3.5 1.5-.76-.19-1.3-.74-1.91-1.35C10.6 13.16 9.5 12 7 12z" />;
  if (base === 'license' || base === 'license.md') return <I cls={c} color="#D4AA00" d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm3.5 12.09l-1.41 1.41L12 12.41 9.91 14.5 8.5 13.09 10.59 11 8.5 8.91 9.91 7.5 12 9.59l2.09-2.09 1.41 1.41L13.41 11l2.09 2.09z" />;
  if (base.includes('lock')) return <I cls={c} color="#888" d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zM9 6c0-1.66 1.34-3 3-3s3 1.34 3 3v2H9V6zm9 14H6V10h12v10zm-6-3c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2z" />;

  // ── Test files ──
  if (name.includes('.test.') || name.includes('.spec.')) return <I cls={c} color="#66BB6A" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />;

  // ── By extension ──
  const icons: Record<string, [string, string]> = {
    // TypeScript / JavaScript
    ts:   ['#3178C6', 'M3 3h18v18H3V3zm9.5 10.5v-1.7c.5.3 1.1.5 1.7.5.8 0 1.2-.3 1.2-.8 0-1.2-3.2-1.2-3.2-3.4 0-1.3.9-2.1 2.3-2.1.5 0 1 .1 1.4.3V8c-.4-.2-.9-.4-1.4-.4-.7 0-1 .3-1 .7 0 1.2 3.2 1.1 3.2 3.4 0 1.4-.9 2.2-2.4 2.2-.6 0-1.3-.1-1.8-.4zM7 8.5h1.8V14h1.6V8.5h1.8V7H7v1.5z'],
    tsx:  ['#61DAFB', 'M14.23 12.004c0-1.22-.99-2.21-2.21-2.21s-2.21.99-2.21 2.21.99 2.21 2.21 2.21 2.21-.99 2.21-2.21zm-2.21 5.58c-4.73 0-8.57-1.5-8.57-3.36s3.84-3.36 8.57-3.36 8.57 1.5 8.57 3.36-3.84 3.36-8.57 3.36zM12.02 2c-1.86 0-3.36 3.84-3.36 8.57s1.5 8.57 3.36 8.57c1.86 0 3.36-3.84 3.36-8.57S13.88 2 12.02 2zM12 22c-1.86 0-5.09-2.83-5.09-8.57S8.57 4.86 12 2c3.43 2.86 5.09 5.56 5.09 11.43S13.86 22 12 22z'],
    js:   ['#F7DF1E', 'M3 3h18v18H3V3zm4.5 14.4c0 1.5.7 2.1 1.9 2.1.7 0 1.2-.2 1.7-.7l-1-1c-.2.2-.4.3-.6.3-.4 0-.5-.3-.5-.8v-3.8h1.3v-1.4H9v-1.7H7.5v1.7H6.2v1.4h1.3v4.9zm5.3-5v1.2c.4-.4 1-.7 1.7-.7 1.5 0 2.3 1.1 2.3 2.7 0 1.7-.8 2.8-2.3 2.8-.7 0-1.3-.3-1.7-.7v.6h-1.5v-7.4h1.5v1.5zm1.2 1.7c-.8 0-1.2.6-1.2 1.5s.4 1.5 1.2 1.5c.8 0 1.2-.6 1.2-1.5s-.4-1.5-1.2-1.5z'],
    jsx:  ['#61DAFB', 'M14.23 12.004c0-1.22-.99-2.21-2.21-2.21s-2.21.99-2.21 2.21.99 2.21 2.21 2.21 2.21-.99 2.21-2.21zm-2.21 5.58c-4.73 0-8.57-1.5-8.57-3.36s3.84-3.36 8.57-3.36 8.57 1.5 8.57 3.36-3.84 3.36-8.57 3.36zM12.02 2c-1.86 0-3.36 3.84-3.36 8.57s1.5 8.57 3.36 8.57c1.86 0 3.36-3.84 3.36-8.57S13.88 2 12.02 2z'],
    mjs:  ['#F7DF1E', 'M3 3h18v18H3V3zm4.5 14.4c0 1.5.7 2.1 1.9 2.1.7 0 1.2-.2 1.7-.7l-1-1c-.2.2-.4.3-.6.3-.4 0-.5-.3-.5-.8v-3.8h1.3v-1.4H9v-1.7H7.5v1.7H6.2v1.4h1.3v4.9z'],
    // Markup
    json: ['#F9A825', 'M5 3h2v2H5v4c0 1.1-.9 2-2 2 1.1 0 2 .9 2 2v4h2v2H5c-1.1 0-2-.9-2-2v-3c0-1.1-.9-2-2-2v-2c1.1 0 2-.9 2-2V5c0-1.1.9-2 2-2zm14 0c1.1 0 2 .9 2 2v3c0 1.1.9 2 2 2v2c-1.1 0-2 .9-2 2v3c0 1.1-.9 2-2 2h-2v-2h2v-4c0-1.1.9-2 2-2-1.1 0-2-.9-2-2V5h-2V3h2zM12 15a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm-4 0a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm8 0a1.5 1.5 0 110-3 1.5 1.5 0 010 3z'],
    html: ['#E44D26', 'M4 2l1.5 17L12 22l6.5-3L20 2H4zm13.1 5H8.3l.2 2.5h8.4l-.7 7.5L12 18.5l-4.2-1.5-.3-3h2.4l.2 1.5 1.9.7 2-.7.2-2.2H7.6L7 7H17.3l-.2 2z'],
    xml:  ['#E44D26', 'M12.89 3l1.96.4L11.11 21l-1.96-.4L12.89 3zm-4.3 5.59L5.17 12l3.42 3.41-1.41 1.41L2.34 12l4.83-4.83 1.42 1.42zm6.82 0l1.41-1.41L21.66 12l-4.83 4.83-1.41-1.41L18.83 12l-3.42-3.41z'],
    md:   ['#42A5F5', 'M20.56 18H3.44A1.44 1.44 0 012 16.56V7.44C2 6.65 2.65 6 3.44 6h17.12c.79 0 1.44.65 1.44 1.44v9.12c0 .79-.65 1.44-1.44 1.44zM6.81 15V9.5H5v5.5h1.81zm1.53-3.2L10.1 15h1.6l1.77-3.2V15h1.53V9.5h-2l-1.34 2.76L10.34 9.5H8.34V15h-.01v-3.2zM19 12.41l-2.13 2.59h1.49V9.5h-1.53v5.5L19 12.41z'],
    css:  ['#42A5F5', 'M5 3l.65 3.34h12.59l-.44 2.16H6.08l.65 3.34h11.14l-.77 3.87-4.33 1.46-3.78-1.46.25-1.33H7.41l-.58 2.89L12 19.64l5.48-1.9L19.15 3H5z'],
    scss: ['#CD6799', 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.65 14.65c-.48.48-1.15.72-1.87.72-.88 0-1.8-.39-2.6-.86-.8.47-1.57.72-2.28.72-1.1 0-1.98-.53-2.39-1.42-.4-.88-.27-1.95.33-2.82.44-.65 1.1-1.17 1.83-1.55-.18-.47-.3-.95-.3-1.44 0-1.1.72-2 1.78-2 .82 0 1.42.55 1.42 1.25 0 .88-.7 1.42-1.93 1.93.38.72.92 1.48 1.52 2.15.38-.53.72-1.12.98-1.72h1.37c-.35.88-.82 1.72-1.4 2.45.72.6 1.5 1.02 2.12 1.02.28 0 .52-.08.7-.25l.72.82z'],
    svg:  ['#FFB13B', 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zM9.5 16.5v-9l7 4.5-7 4.5z'],
    // Config
    yml:  ['#CB171E', 'M12 2L2 7v10l10 5 10-5V7L12 2zm-1.5 13.5h-2V12l-2 2.5V12L9 9l2.5 3v3.5h-2zm7 0h-2V12l-2 2.5V12l2.5-3 2.5 3v3.5h-2z'],
    yaml: ['#CB171E', 'M12 2L2 7v10l10 5 10-5V7L12 2zm-1.5 13.5h-2V12l-2 2.5V12L9 9l2.5 3v3.5h-2zm7 0h-2V12l-2 2.5V12l2.5-3 2.5 3v3.5h-2z'],
    toml: ['#9C4121', 'M3 3h18v4H3V3zm2 6h14v12H5V9zm2 2v8h10v-8H7zm2 2h6v1H9v-1zm0 3h6v1H9v-1z'],
    env:  ['#ECD53F', 'M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-1 6h2v2h-2V7zm0 4h2v6h-2v-6z'],
    // Languages
    py:   ['#3776AB', 'M9.585 2c-1.37 0-2.585 1.18-2.585 2.6V7H12v.8H5.615C4.245 7.8 3 9.08 3 10.5v3c0 1.42 1.245 2.7 2.615 2.7H7.5v-2.4c0-1.42 1.2-2.6 2.585-2.6h4.83c1.135 0 2.085-.98 2.085-2.1V4.6c0-1.12-.95-2.15-2.085-2.4-.72-.16-1.47-.2-2.33-.2zM9.2 3.8a.9.9 0 110 1.8.9.9 0 010-1.8zM16.5 7.8v2.4c0 1.42-1.2 2.6-2.585 2.6H9.085C7.95 12.8 7 13.78 7 14.9v3.5c0 1.12 1.1 1.78 2.585 2.1 1.78.39 3.49.46 4.83 0C15.77 20.15 16.5 19.6 16.5 18.4v-1.6H12v-.8h6.385c1.37 0 1.88-1.08 2.115-2.7.25-1.68.24-2.76 0-4.6C20.28 7.6 19.75 7.8 18.385 7.8H16.5zM14.8 18.4a.9.9 0 110 1.8.9.9 0 010-1.8z'],
    go:   ['#00ADD8', 'M1.811 10.231c-.047 0-.058-.023-.035-.059l.246-.315c.023-.035.081-.058.128-.058h4.172c.047 0 .058.035.035.07l-.199.303c-.023.036-.082.07-.117.07l-4.23-.011zM.047 11.306c-.047 0-.059-.023-.035-.058l.245-.316c.023-.035.082-.058.129-.058h5.328c.047 0 .07.035.058.07l-.093.28c-.012.047-.058.07-.105.07l-5.527.012zm2.828 1.075c-.047 0-.059-.035-.035-.07l.163-.292c.023-.035.07-.07.117-.07h2.337c.047 0 .07.035.07.082l-.023.28c0 .047-.047.082-.082.082l-2.547-.012zM18.66 10c-1.592.372-2.686.627-4.254.99-.37.082-.394.093-.71-.257-.363-.398-.632-.656-1.14-.89-1.534-.714-3.023-.502-4.39.386-1.615 1.05-2.45 2.591-2.427 4.39.023 1.82 1.29 3.326 3.07 3.56 1.523.2 2.814-.35 3.87-1.477.21-.234.398-.491.617-.772H9.387c-.513 0-.64-.315-.467-.725.315-.756.896-2.022 1.243-2.66.082-.152.28-.397.606-.397h6.767c-.047.642-.047 1.265-.164 1.908-.35 1.92-1.173 3.665-2.508 5.118-1.825 1.99-4.078 3.07-6.792 3.117-2.127.035-4.007-.607-5.58-2.127C1.166 18.86.5 17.204.372 15.268c-.152-2.31.627-4.39 2.033-6.194 1.546-1.978 3.547-3.234 5.952-3.747.815-.164 1.64-.222 2.474-.117 1.71.222 3.117.968 4.254 2.264.618.702 1.1 1.498 1.452 2.37.07.164.023.245-.152.292z'],
    rs:   ['#DEA584', 'M23.835 11.703a1.41 1.41 0 00-.744-.474l-.652-.186c-.031-.109-.07-.215-.115-.318l.381-.573a1.41 1.41 0 00-.144-.877 1.41 1.41 0 00-.634-.602l-.001-.001-.652-.372a4.112 4.112 0 00-.207-.261l.09-.693a1.41 1.41 0 00-1.254-1.565l-.748-.07a3.725 3.725 0 00-.272-.174l-.214-.676c-.152-.48-.568-.822-1.064-.874l-.745-.078a3.99 3.99 0 00-.314-.066l-.486-.589a1.41 1.41 0 00-1.373-.404l-.726.186a4.083 4.083 0 00-.325.054L13.24 3.48a1.41 1.41 0 00-.878.145 1.41 1.41 0 00-.603.633L11.388 4.91a3.99 3.99 0 00-.262.207l-.693-.09a1.41 1.41 0 00-1.565 1.254l-.07.748a3.725 3.725 0 00-.174.272l-.676.215a1.41 1.41 0 00-.874 1.063l-.078.745a3.99 3.99 0 00-.066.314l-.589.486A1.41 1.41 0 006.136 11l.186.727c-.019.108-.034.216-.054.325l-.578.476a1.41 1.41 0 00-.145.877c.063.31.264.574.534.721l.001.001.652.372c.064.089.133.176.207.261l-.09.693A1.41 1.41 0 008.102 16l.748.07c.056.06.114.118.174.174l.215.676c.152.48.568.822 1.064.874l.745.078c.021.023.043.045.066.066l.486.589c.326.396.84.55 1.321.41l.726-.186.054-.054.325-.054.476.578a1.41 1.41 0 001.513.268l.001-.001.652-.372a3.725 3.725 0 00.261-.207l.693.09a1.41 1.41 0 001.565-1.254l.07-.748c.06-.056.118-.114.174-.174l.676-.215a1.41 1.41 0 00.874-1.063l.078-.745c.023-.021.045-.043.066-.066l.589-.486a1.41 1.41 0 00.404-1.321L23.835 11.703zM12 16.5a4.5 4.5 0 110-9 4.5 4.5 0 010 9z'],
    java: ['#ED8B00', 'M8.851 18.56s-.917.534.653.714c1.902.218 2.874.187 4.969-.211 0 0 .552.346 1.321.646-4.699 2.013-10.633-.118-6.943-1.149zM8.276 15.933s-1.028.762.542.924c2.032.209 3.636.227 6.413-.308 0 0 .384.389.987.602-5.679 1.661-12.007.13-7.942-1.218zM13.116 11.475c1.158 1.333-.304 2.533-.304 2.533s2.939-1.518 1.589-3.418c-1.261-1.772-2.228-2.652 3.007-5.688 0 0-8.216 2.052-4.292 6.573zM19.33 20.504s.679.559-.747.991c-2.712.822-11.288 1.069-13.669.033-.856-.373.75-.89 1.254-.998.527-.114.828-.093.828-.093-.953-.671-6.156 1.317-2.643 1.887 9.58 1.553 17.462-.7 14.977-1.82zM9.292 13.21s-4.362 1.036-1.544 1.412c1.189.159 3.561.123 5.77-.062 1.806-.152 3.618-.477 3.618-.477s-.637.272-1.098.587c-4.429 1.165-12.986.623-10.522-.569 2.082-1.006 3.776-.891 3.776-.891zM17.116 17.584c4.503-2.34 2.421-4.589.968-4.285-.356.074-.515.138-.515.138s.132-.207.385-.297c2.875-1.011 5.086 2.981-.928 4.562 0 0 .07-.062.09-.118zM14.401 0s2.494 2.494-2.365 6.33c-3.896 3.077-.889 4.831 0 6.836-2.274-2.052-3.943-3.858-2.824-5.541 1.644-2.469 6.197-3.665 5.189-7.625z'],
    sh:   ['#4EAA25', 'M5 13l4 4-4 4M12 17h8M2 3h20v18H2z'],
    bash: ['#4EAA25', 'M5 13l4 4-4 4M12 17h8M2 3h20v18H2z'],
    sql:  ['#E38C00', 'M12 3C7.58 3 4 4.79 4 7v10c0 2.21 3.58 4 8 4s8-1.79 8-4V7c0-2.21-3.58-4-8-4zm0 2c3.87 0 6 1.5 6 2s-2.13 2-6 2-6-1.5-6-2 2.13-2 6-2zM6 17V14c1.33.87 3.5 1.42 6 1.42s4.67-.55 6-1.42V17c0 .5-2.13 2-6 2s-6-1.5-6-2zm0-5V9c1.33.87 3.5 1.42 6 1.42s4.67-.55 6-1.42V12c0 .5-2.13 2-6 2s-6-1.5-6-2z'],
    graphql: ['#E535AB', 'M12 2L2.39 7v10L12 22l9.61-5V7L12 2zm0 3.28l5.55 3.08v6.28L12 17.72l-5.55-3.08V8.36L12 5.28z'],
    tf:   ['#7B42BC', 'M1 2.5L8.5 7v9l-7.5-4.5v-9zm8.5 4.5l7.5-4.5v9L9.5 16V7zm8.5.5v9l-7.5 4.5v-9L18 7.5z'],
    // Images
    png:  ['#8BC34A', 'M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z'],
    jpg:  ['#8BC34A', 'M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z'],
    jpeg: ['#8BC34A', 'M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z'],
    gif:  ['#8BC34A', 'M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z'],
    webp: ['#8BC34A', 'M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z'],
    ico:  ['#8BC34A', 'M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z'],
    // Other
    txt:  ['#90A4AE', 'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zM6 20V4h7v5h5v11H6zm2-6h8v1H8v-1zm0 3h5v1H8v-1zm0-6h8v1H8v-1z'],
    log:  ['#78909C', 'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zM6 20V4h7v5h5v11H6zm2-6h8v1H8v-1zm0 3h5v1H8v-1zm0-6h8v1H8v-1z'],
    map:  ['#78909C', 'M20.5 3l-.16.03L15 5.1 9 3 3.36 4.9c-.21.07-.36.25-.36.48V20.5c0 .28.22.5.5.5l.16-.03L9 18.9l6 2.1 5.64-1.9c.21-.07.36-.25.36-.48V3.5c0-.28-.22-.5-.5-.5zM15 19l-6-2.11V5l6 2.11V19z'],
    lock: ['#888', 'M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zM12 17c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zM9 8V6c0-1.66 1.34-3 3-3s3 1.34 3 3v2H9z'],
    woff: ['#78909C', 'M9.93 13.5h4.14L12 7.98zM20 2H4c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-4.05 16.5l-1.14-3H9.17l-1.12 3H5.96l5.11-13h1.86l5.11 13h-2.09z'],
    woff2:['#78909C', 'M9.93 13.5h4.14L12 7.98zM20 2H4c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-4.05 16.5l-1.14-3H9.17l-1.12 3H5.96l5.11-13h1.86l5.11 13h-2.09z'],
    ttf:  ['#78909C', 'M9.93 13.5h4.14L12 7.98zM20 2H4c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-4.05 16.5l-1.14-3H9.17l-1.12 3H5.96l5.11-13h1.86l5.11 13h-2.09z'],
    prisma:['#2D3748', 'M21.81 10.25a.75.75 0 00-.04-.56L17.37 2.2a.75.75 0 00-1.24-.14L3.27 17.18a.75.75 0 00.08 1.04l5.61 4.88a.75.75 0 00.84.1l11.66-6.06a.75.75 0 00.35-.89l-3.24-9.2 3.24 3.2zM10.32 20.61L6.25 17.08 15.9 5.15l2.78 7.91-8.36 7.55z'],
  };

  if (icons[ext]) return <I cls={c} color={icons[ext][0]} d={icons[ext][1]} />;

  // Default file icon
  return <I cls={c} color="#90A4AE" d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zm4 18H6V4h7v5h5v11z" />;
}

function FolderIcon({ name, expanded, className = 'w-4 h-4' }: { name: string; expanded: boolean; className?: string }) {
  const n = name.toLowerCase();
  const colors: Record<string, string> = {
    src: '#42A5F5', components: '#7E57C2', hooks: '#AB47BC', services: '#26A69A',
    utils: '#78909C', types: '#3178C6', pages: '#66BB6A', modules: '#5C6BC0',
    config: '#8D6E63', public: '#FFA726', assets: '#FFA726', images: '#66BB6A',
    styles: '#CE93D8', tests: '#66BB6A', __tests__: '#66BB6A', e2e: '#66BB6A',
    docs: '#42A5F5', '.claude': '#DA7756', agents: '#FF7043', node_modules: '#78909C',
    dist: '#78909C', build: '#78909C', '.git': '#F05032', infra: '#7B42BC',
    routes: '#26A69A', controllers: '#26A69A', middleware: '#78909C',
    database: '#E38C00', queries: '#E38C00', shared: '#78909C',
    workflows: '#5C6BC0', '.github': '#F05032', scripts: '#4EAA25',
    knowledge: '#FF9800', memory: '#AB47BC', rules: '#FF7043',
    prds: '#42A5F5', plans: '#42A5F5', api: '#26A69A',
  };
  const color = colors[n] ?? '#90A4AE';

  if (expanded) {
    return <I cls={className} color={color} d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z" />;
  }
  return <I cls={className} color={color} d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />;
}

// ── Resize Hook ──

function useResizable(direction: 'horizontal' | 'vertical', initial: number, min: number, max: number, invert = false) {
  const [size, setSize] = useState(initial);
  const dragging = useRef(false);
  const startPos = useRef(0);
  const startSize = useRef(0);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    startPos.current = direction === 'horizontal' ? e.clientX : e.clientY;
    startSize.current = size;
    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const raw = direction === 'horizontal'
        ? ev.clientX - startPos.current
        : startPos.current - ev.clientY; // inverted for bottom panel
      const delta = invert ? -raw : raw;
      setSize(Math.min(max, Math.max(min, startSize.current + delta)));
    };
    const onMouseUp = () => { dragging.current = false; document.removeEventListener('mousemove', onMouseMove); document.removeEventListener('mouseup', onMouseUp); };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [size, direction, min, max]);

  return { size, onMouseDown };
}

// ── File Tree ──

function FileTreeNode({ name, path, isDir, children, selectedFile, onSelect, onDelete, level = 0, changedStatus }: {
  name: string; path: string; isDir: boolean; children?: any[]; selectedFile?: string;
  onSelect: (p: string) => void; onDelete: (p: string) => void; level?: number; changedStatus?: string;
}) {
  const [expanded, setExpanded] = useState(level < 1);
  const [hovered, setHovered] = useState(false);
  const isSelected = selectedFile === path;
  const sc = changedStatus === 'added' ? 'text-emerald-400' : changedStatus === 'deleted' ? 'text-red-400' : changedStatus === 'modified' ? 'text-amber-400' : '';

  if (isDir) {
    return (
      <div>
        <button onClick={() => setExpanded(!expanded)}
          className={`w-full flex items-center gap-1.5 px-2 py-[3px] text-left hover:bg-white/5 rounded text-[11px] ${sc || 'text-gray-400'}`}
          style={{ paddingLeft: `${level * 14 + 8}px` }}>
          {expanded ? <ChevronDown className="w-3 h-3 shrink-0 text-gray-600" /> : <ChevronRight className="w-3 h-3 shrink-0 text-gray-600" />}
          <FolderIcon name={name} expanded={expanded} className="w-4 h-4" />
          <span className="truncate font-mono">{name}</span>
        </button>
        {expanded && children?.map(c => <FileTreeNode key={c.path} {...c} selectedFile={selectedFile} onSelect={onSelect} onDelete={onDelete} level={level + 1} />)}
      </div>
    );
  }

  return (
    <div className="relative" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <button onClick={() => onSelect(path)}
        className={`w-full flex items-center gap-1.5 px-2 py-[3px] text-left rounded text-[11px] font-mono truncate ${isSelected ? 'bg-blue-500/15 text-blue-400' : `hover:bg-white/5 ${sc || 'text-gray-400'}`}`}
        style={{ paddingLeft: `${level * 14 + 8}px` }}>
        <FileIcon name={name} className="w-4 h-4" />
        <span className="truncate">{name}</span>
        {changedStatus && <span className={`ml-auto text-[9px] font-bold shrink-0 ${sc}`}>{changedStatus === 'added' ? 'A' : changedStatus === 'deleted' ? 'D' : 'M'}</span>}
      </button>
      {hovered && (
        <button onClick={(e) => { e.stopPropagation(); onDelete(path); }}
          className="absolute right-1 top-0.5 p-0.5 text-gray-600 hover:text-red-400 rounded" title="Delete file">
          <Trash2 className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}

function buildFileTree(files: { path: string; status?: string }[]): any[] {
  const root: Record<string, any> = {};
  for (const file of files) {
    const parts = file.path.split('/');
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (i === parts.length - 1) current[part] = { name: part, path: file.path, isDir: false, changedStatus: file.status };
      else { if (!current[part]) current[part] = { name: part, path: parts.slice(0, i + 1).join('/'), isDir: true, _children: {} }; current = current[part]._children; }
    }
  }
  function toArray(obj: Record<string, any>): any[] {
    return Object.values(obj).map(item => item.isDir && item._children ? { ...item, children: toArray(item._children) } : item)
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  }
  return toArray(root);
}

// ── Diff Viewer ──

function DiffView({ diff }: { diff: string }) {
  if (!diff) return <div className="text-sm text-gray-500 p-4">No changes for this file</div>;
  return (
    <pre className="text-[11px] font-mono leading-relaxed overflow-auto h-full">
      {diff.split('\n').map((line, i) => {
        let cls = 'text-gray-400 px-4 py-px';
        if (line.startsWith('+') && !line.startsWith('+++')) cls = 'text-emerald-400 bg-emerald-400/5 px-4 py-px';
        else if (line.startsWith('-') && !line.startsWith('---')) cls = 'text-red-400 bg-red-400/5 px-4 py-px';
        else if (line.startsWith('@@')) cls = 'text-blue-400/60 bg-blue-400/5 px-4 py-px';
        else if (line.startsWith('diff ') || line.startsWith('index ')) cls = 'text-gray-600 px-4 py-px';
        return <div key={i} className={cls}>{line || ' '}</div>;
      })}
    </pre>
  );
}

// ── Main ──

function PreviewBar({ id, previewService, setPreviewService, services, onClose }: {
  id: string; previewService: string; setPreviewService: (s: string) => void; services: any[]; onClose: () => void;
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-1 bg-surface-100/30 border-b border-border/20 shrink-0">
      <Eye className="w-3 h-3 text-blue-400" />
      <span className="text-[10px] font-label uppercase tracking-wider text-gray-500">Preview</span>
      <select value={previewService} onChange={e => setPreviewService(e.target.value)} className="bg-surface-100 border border-border/30 rounded text-[10px] font-mono text-gray-300 px-1.5 py-0.5">
        {services?.filter((s: any) => s.status === 'ready').map((s: any) => (<option key={s.name} value={s.name}>{s.name} :{s.port}</option>))}
      </select>
      <a href={`/api/workspaces/${id}/preview${previewService ? `?service=${previewService}` : ''}`} target="_blank" rel="noopener noreferrer" className="text-gray-600 hover:text-gray-300 p-0.5" title="Open in new tab"><ExternalLink className="w-3 h-3" /></a>
      <span className="flex-1" />
      <button onClick={onClose} className="text-gray-600 hover:text-gray-300 p-0.5"><X className="w-3 h-3" /></button>
    </div>
  );
}

function ActivityTimeline({ activity }: { activity: any[] }) {
  const icons: Record<string, string> = { workspace_created: '🏗️', setup_completed: '✅', commit: '📝', push: '🚀', service_started: '▶️', service_stopped: '⏹️' };
  return (
    <div className="p-3 space-y-2">
      {activity.length === 0 ? <p className="text-xs text-gray-600">No activity yet</p> : activity.map((a, i) => (
        <div key={i} className="flex items-start gap-2 text-[11px]">
          <span className="shrink-0 mt-0.5">{icons[a.action] ?? '📌'}</span>
          <div className="flex-1 min-w-0">
            <span className="text-gray-300 font-mono">{a.action.replace(/_/g, ' ')}</span>
            {a.details?.message && <span className="text-gray-500 ml-1 truncate">— {a.details.message}</span>}
            {a.details?.hash && <span className="text-gray-600 ml-1 font-mono">{a.details.hash.slice(0, 7)}</span>}
          </div>
          <span className="text-[9px] text-gray-700 shrink-0">{new Date(a.timestamp).toLocaleTimeString()}</span>
        </div>
      ))}
    </div>
  );
}

let termIdCounter = 1;

export default function WorkspaceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [workspace, setWorkspace] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [allFiles, setAllFiles] = useState<{ path: string; status?: string }[]>([]);
  const [changedCount, setChangedCount] = useState(0);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>('');
  const [editedContent, setEditedContent] = useState<string>('');
  const [fileDiff, setFileDiff] = useState<string>('');
  const [viewMode, setViewMode] = useState<'code' | 'diff' | 'preview'>('code');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showCommitModal, setShowCommitModal] = useState(false);
  const [commitMsg, setCommitMsg] = useState('');
  const [committing, setCommitting] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [showNewFile, setShowNewFile] = useState(false);
  const [newFilePath, setNewFilePath] = useState('');
  // PR modal
  const [showPrModal, setShowPrModal] = useState(false);
  const [prTitle, setPrTitle] = useState('');
  const [prBody, setPrBody] = useState('');
  const [creatingPr, setCreatingPr] = useState(false);

  // Preview iframe
  const [showPreview, setShowPreview] = useState(false);
  const [previewService, setPreviewService] = useState<string>('');

  // Config editor + activity
  const [showConfig, setShowConfig] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const [activity, setActivity] = useState<any[]>([]);
  const [splitPreview, setSplitPreview] = useState(false);

  // Embedded chat
  const [showChat, setShowChat] = useState(false);

  const [terminals, setTerminals] = useState<{ id: string; label: string }[]>([{ id: 'default', label: 'Terminal 1' }]);
  const [activeTerminal, setActiveTerminal] = useState('default');
  const [terminalVisible, setTerminalVisible] = useState(true);

  // Resizable panels
  const sidebar = useResizable('horizontal', 240, 160, 400);
  const chatPanel = useResizable('horizontal', 384, 280, 600, true);
  const monacoRef = useRef<any>(null);
  const termPanel = useResizable('vertical', 220, 100, 500);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const [ws, files] = await Promise.all([workspaces.get(id), workspaces.getAllFiles(id).catch(() => [])]);
      setWorkspace(ws);
      setAllFiles(files);
      setChangedCount(files.filter((f: any) => f.status).length);
    } catch {}
    setLoading(false);
  }, [id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (!id) return; const i = setInterval(async () => { try { setWorkspace(await workspaces.get(id)); } catch {} }, 15000); return () => clearInterval(i); }, [id]);

  // Load activity when panel opens
  useEffect(() => {
    if (!showActivity || !id) return;
    workspaces.getActivity(id).then(setActivity).catch(() => {});
  }, [showActivity, id]);

  // Keyboard shortcuts
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Ctrl/Cmd + ` → toggle terminal
      if ((e.metaKey || e.ctrlKey) && e.key === '`') { e.preventDefault(); setTerminalVisible(v => !v); }
      // Ctrl/Cmd + J → toggle chat
      if ((e.metaKey || e.ctrlKey) && e.key === 'j') { e.preventDefault(); setShowChat(v => !v); }
      // Ctrl/Cmd + B → toggle sidebar
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') { e.preventDefault(); sidebar.size > 0 ? sidebar.onMouseDown({ preventDefault: () => {}, clientX: 0, clientY: 0 } as any) : null; }
      // Ctrl/Cmd + P → toggle preview
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'p') { e.preventDefault(); setShowPreview(v => !v); }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  async function selectFile(path: string) {
    if (!id) return;
    if (dirty && !confirm('Discard unsaved changes?')) return;
    setSelectedFile(path); setDirty(false);
    setViewMode(path.endsWith('.md') ? 'preview' : 'code');
    try {
      const [content, diffData] = await Promise.all([workspaces.getFile(id, path).catch(() => ({ content: '' })), workspaces.getDiff(id).catch(() => ({ files: [] }))]);
      const c = content.content ?? '';
      setFileContent(c); setEditedContent(c);
      setFileDiff(diffData.files?.find((f: any) => f.path === path)?.diff ?? '');
    } catch {}
  }

  async function handleSave() {
    if (!id || !selectedFile) return;
    setSaving(true);
    try { await workspaces.saveFile(id, selectedFile, editedContent); setFileContent(editedContent); setDirty(false); } catch (err: any) { alert(err.message); }
    setSaving(false);
  }

  async function handleCommit() {
    if (!id || !commitMsg.trim()) return;
    setCommitting(true);
    try { await workspaces.commit(id, commitMsg); setCommitMsg(''); setShowCommitModal(false); load(); } catch (err: any) { alert(err.message); }
    setCommitting(false);
  }

  async function handlePush() { if (!id) return; setPushing(true); try { await workspaces.push(id); } catch (err: any) { alert(err.message); } setPushing(false); }

  async function handleNewFile() {
    if (!id || !newFilePath.trim()) return;
    try { await workspaces.createFile(id, newFilePath.trim()); setNewFilePath(''); setShowNewFile(false); load(); selectFile(newFilePath.trim()); } catch (err: any) { alert(err.message); }
  }

  async function handleDeleteFile(path: string) {
    if (!id || !confirm(`Delete ${path}?`)) return;
    try { await workspaces.deleteFile(id, path); if (selectedFile === path) { setSelectedFile(null); setDirty(false); } load(); } catch (err: any) { alert(err.message); }
  }

  async function handleCreatePR() {
    if (!id || !prTitle.trim()) return;
    setCreatingPr(true);
    try {
      const pr = await workspaces.createPR(id, prTitle, prBody);
      setPrTitle(''); setPrBody(''); setShowPrModal(false);
      if (pr.url) window.open(pr.url, '_blank');
    } catch (err: any) { alert(err.message); }
    setCreatingPr(false);
  }

  function addTerminal() { const nid = `term-${termIdCounter++}`; setTerminals(p => [...p, { id: nid, label: `Terminal ${p.length + 1}` }]); setActiveTerminal(nid); }
  function closeTerminal(tid: string) { if (terminals.length <= 1) return; setTerminals(p => p.filter(t => t.id !== tid)); if (activeTerminal === tid) setActiveTerminal(terminals.find(t => t.id !== tid)!.id); }

  function getLanguage(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    const map: Record<string, string> = {
      ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
      mjs: 'javascript', cjs: 'javascript', json: 'json', md: 'markdown', mdx: 'markdown',
      css: 'css', scss: 'scss', less: 'less', html: 'html', xml: 'xml',
      yml: 'yaml', yaml: 'yaml', toml: 'ini', py: 'python', rb: 'ruby',
      go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift',
      c: 'c', cpp: 'cpp', h: 'c', sh: 'shell', bash: 'shell', zsh: 'shell',
      sql: 'sql', graphql: 'graphql', tf: 'hcl', env: 'ini', txt: 'plaintext',
      log: 'plaintext', prisma: 'graphql', dockerfile: 'dockerfile',
    };
    return map[ext] ?? 'plaintext';
  }

  function handleEditorMount(editor: any) {
    monacoRef.current = editor;
    // Cmd+S to save
    editor.addCommand(2048 /* KeyMod.CtrlCmd */ | 49 /* KeyCode.KeyS */, () => handleSave());
  }

  if (loading || !workspace) return <div className="flex items-center justify-center h-full"><Loader2 className="w-6 h-6 animate-spin text-gray-500" /></div>;

  const fileTree = buildFileTree(allFiles);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-4 py-1.5 border-b border-border/30 bg-surface-50/50 shrink-0">
        <div className="flex items-center gap-3">
          <Link to="/workspaces" className="text-gray-400 hover:text-white"><ArrowLeft className="w-4 h-4" /></Link>
          <GitBranch className="w-3.5 h-3.5 text-emerald-400" />
          <span className="text-xs font-heading font-semibold text-white">{workspace.name}</span>
          <span className="text-[10px] font-mono text-gray-500">{workspace.branch} → {workspace.baseBranch}</span>
          <span className="flex-1" />

          {workspace.services?.map((svc: any) => (
            <div key={svc.name} className="flex items-center gap-1 text-[10px] font-mono">
              <span className={`w-1.5 h-1.5 rounded-full ${svc.status === 'ready' ? 'bg-emerald-400' : svc.status === 'starting' ? 'bg-amber-400 animate-pulse' : 'bg-gray-600'}`} />
              <span className="text-gray-400">{svc.name}:{svc.port}</span>
              {svc.status === 'stopped' && <button onClick={() => workspaces.startService(id!, svc.name).then(load)} className="text-emerald-400"><Play className="w-2.5 h-2.5" /></button>}
              {svc.status === 'ready' && <button onClick={() => workspaces.stopService(id!, svc.name).then(load)} className="text-red-400"><Square className="w-2.5 h-2.5" /></button>}
            </div>
          ))}

          <div className="flex items-center gap-1 border-l border-border/20 pl-3 ml-2">
            <button onClick={() => setShowCommitModal(true)} className="btn-ghost text-[11px] py-1 px-2 flex items-center gap-1" title="Commit">
              <GitCommit className="w-3.5 h-3.5" />Commit
              {changedCount > 0 && <span className="bg-amber-400/20 text-amber-400 text-[9px] px-1 rounded-full">{changedCount}</span>}
            </button>
            <button onClick={handlePush} disabled={pushing} className="btn-ghost text-[11px] py-1 px-2 flex items-center gap-1 disabled:opacity-50">
              <Upload className="w-3.5 h-3.5" />{pushing ? '...' : 'Push'}
            </button>
            <button onClick={() => setShowPrModal(true)} className="btn-ghost text-[11px] py-1 px-2 flex items-center gap-1 text-blue-400">
              <GitPullRequest className="w-3.5 h-3.5" />PR
            </button>
          </div>
          {/* Preview toggle — only when a service is ready */}
          {workspace.services?.some((s: any) => s.status === 'ready') && (
            <button onClick={() => setShowPreview(v => !v)} className={`btn-ghost p-1 text-xs ${showPreview ? 'text-blue-400' : ''}`} title="Toggle Preview">
              <Eye className="w-3.5 h-3.5" />
            </button>
          )}
          {showPreview && (
            <button onClick={() => setSplitPreview(v => !v)} className={`btn-ghost p-1 text-xs ${splitPreview ? 'text-blue-400' : ''}`} title="Split Preview">
              <PanelRightOpen className="w-3.5 h-3.5" />
            </button>
          )}
          <button onClick={() => setShowChat(v => !v)} className={`btn-ghost p-1 text-xs ${showChat ? 'text-blue-400' : ''}`} title="Chat (⌘J)"><MessageSquare className="w-3.5 h-3.5" /></button>
          <button onClick={() => setShowActivity(v => !v)} className={`btn-ghost p-1 text-xs ${showActivity ? 'text-blue-400' : ''}`} title="Activity"><History className="w-3.5 h-3.5" /></button>
          <button onClick={() => setShowConfig(true)} className="btn-ghost p-1 text-xs" title="Workspace Config"><Settings className="w-3.5 h-3.5" /></button>
          <button onClick={load} className="btn-ghost p-1 text-xs" title="Refresh"><RefreshCw className="w-3.5 h-3.5" /></button>
        </div>
      </div>

      {/* Body — fixed, no scroll */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* Sidebar */}
        <div className="shrink-0 overflow-y-auto bg-surface-50/30 flex flex-col" style={{ width: sidebar.size }}>
          <div className="px-3 py-1.5 text-[10px] font-label uppercase tracking-wider text-gray-600 flex items-center justify-between shrink-0">
            <span>Explorer</span>
            <div className="flex items-center gap-1">
              <button onClick={() => setShowNewFile(true)} className="text-gray-600 hover:text-gray-300 p-0.5" title="New File"><FilePlus className="w-3.5 h-3.5" /></button>
              <span className="text-gray-700 text-[9px]">{allFiles.length}</span>
            </div>
          </div>
          {showNewFile && (
            <div className="px-2 pb-1 shrink-0">
              <input value={newFilePath} onChange={e => setNewFilePath(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleNewFile(); if (e.key === 'Escape') setShowNewFile(false); }}
                placeholder="path/to/file.ts" autoFocus
                className="w-full bg-surface-100 border border-border/30 rounded px-2 py-0.5 text-[10px] font-mono text-gray-300 placeholder:text-gray-600 focus:outline-none focus:border-blue-500/50" />
            </div>
          )}
          <div className="flex-1 overflow-y-auto min-h-0">
            {fileTree.length === 0 ? <div className="px-3 py-4 text-xs text-gray-600">No files</div> :
              fileTree.map(n => <FileTreeNode key={n.path} {...n} selectedFile={selectedFile ?? undefined} onSelect={selectFile} onDelete={handleDeleteFile} />)}
          </div>
        </div>

        {/* Sidebar resize handle */}
        <div onMouseDown={sidebar.onMouseDown} className="w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-blue-500/30 active:bg-blue-500/50 transition-colors" />

        {/* Right: editor + terminal */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
          {/* Editor area (with optional split preview + activity panel) */}
          <div className="flex-1 flex overflow-hidden min-h-0">
          <div className={`flex-1 flex flex-col overflow-hidden min-h-0 ${splitPreview && showPreview ? 'w-1/2' : ''}`}>
            {selectedFile ? (
              <>
                <div className="flex items-center gap-1 px-3 py-1 border-b border-border/20 bg-surface-100/30 shrink-0">
                  <FileText className="w-3 h-3 text-gray-500" />
                  <span className="text-[11px] font-mono text-gray-300 truncate">{selectedFile}</span>
                  {dirty && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />}
                  <span className="flex-1" />
                  {dirty && (
                    <button onClick={handleSave} disabled={saving} className="text-[10px] px-2 py-0.5 rounded bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 flex items-center gap-1 disabled:opacity-50">
                      <Save className="w-3 h-3" />{saving ? '...' : 'Save'} <span className="text-gray-600 text-[9px]">⌘S</span>
                    </button>
                  )}
                  <button onClick={() => setViewMode('code')} className={`text-[10px] font-mono px-2 py-0.5 rounded ${viewMode === 'code' ? 'bg-blue-500/10 text-blue-400' : 'text-gray-500 hover:text-gray-300'}`}>Code</button>
                  {selectedFile.endsWith('.md') && (
                    <button onClick={() => setViewMode('preview')} className={`text-[10px] font-mono px-2 py-0.5 rounded ${viewMode === 'preview' ? 'bg-blue-500/10 text-blue-400' : 'text-gray-500 hover:text-gray-300'}`}>Preview</button>
                  )}
                  <button onClick={() => setViewMode('diff')} className={`text-[10px] font-mono px-2 py-0.5 rounded ${viewMode === 'diff' ? 'bg-blue-500/10 text-blue-400' : 'text-gray-500 hover:text-gray-300'}`}>Diff</button>
                  <button onClick={() => { if (dirty && !confirm('Discard?')) return; setSelectedFile(null); setDirty(false); }} className="text-gray-600 hover:text-gray-300 p-0.5"><X className="w-3 h-3" /></button>
                </div>
                <div className="flex-1 min-h-0 overflow-hidden">
                  {viewMode === 'code' ? (
                    <Editor
                      height="100%"
                      language={getLanguage(selectedFile)}
                      value={editedContent}
                      onChange={v => { const val = v ?? ''; setEditedContent(val); setDirty(val !== fileContent); }}
                      onMount={handleEditorMount}
                      theme="vs-dark"
                      options={{
                        fontSize: 12,
                        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                        fontLigatures: true,
                        minimap: { enabled: true, scale: 1 },
                        scrollBeyondLastLine: false,
                        smoothScrolling: true,
                        cursorBlinking: 'smooth',
                        cursorSmoothCaretAnimation: 'on',
                        renderLineHighlight: 'all',
                        lineNumbers: 'on',
                        glyphMargin: false,
                        folding: true,
                        bracketPairColorization: { enabled: true },
                        autoIndent: 'full',
                        formatOnPaste: true,
                        tabSize: 2,
                        wordWrap: selectedFile.endsWith('.md') ? 'on' : 'off',
                        padding: { top: 8, bottom: 8 },
                      }}
                    />
                  ) : viewMode === 'preview' ? (
                    <div className="h-full overflow-auto bg-[rgb(13,17,28)] px-4 py-4">
                      <div className="w-full !max-w-none prose prose-invert prose-sm
                        prose-headings:text-gray-200 prose-headings:font-semibold prose-headings:border-b prose-headings:border-border/20 prose-headings:pb-2 prose-headings:mb-4
                        prose-h1:text-2xl prose-h2:text-xl prose-h3:text-lg
                        prose-p:text-gray-400 prose-p:leading-relaxed
                        prose-a:text-blue-400 prose-a:no-underline hover:prose-a:underline
                        prose-strong:text-gray-300
                        prose-code:text-amber-400 prose-code:bg-surface-200/50 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-[12px] prose-code:font-mono
                        prose-pre:bg-surface-200/30 prose-pre:border prose-pre:border-border/20 prose-pre:rounded-lg
                        prose-li:text-gray-400 prose-li:marker:text-gray-600
                        prose-blockquote:border-blue-500/40 prose-blockquote:text-gray-500
                        prose-table:text-gray-400 prose-th:text-gray-300 prose-th:border-border/30 prose-td:border-border/20
                        prose-hr:border-border/30
                        prose-img:rounded-lg prose-img:border prose-img:border-border/20
                      ">
                        {renderMarkdown(editedContent)}
                      </div>
                    </div>
                  ) : (
                    <div className="h-full overflow-auto">
                      <DiffView diff={fileDiff} />
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-gray-600">
                <div className="text-center">
                  <FileCode className="w-8 h-8 mx-auto mb-2 text-gray-700" />
                  <p className="text-xs">Select a file to edit</p>
                  <p className="text-[10px] text-gray-700 mt-0.5">⌘S to save</p>
                </div>
              </div>
            )}
          </div>

          {/* Split preview — side by side with editor */}
          {showPreview && splitPreview && (
            <div className="w-1/2 border-l border-border/20 flex flex-col overflow-hidden">
              <PreviewBar id={id!} previewService={previewService} setPreviewService={setPreviewService} services={workspace.services} onClose={() => setShowPreview(false)} />
              <iframe src={`/api/workspaces/${id}/preview${previewService ? `?service=${previewService}` : ''}`} className="flex-1 w-full bg-white border-none" title="Preview" />
            </div>
          )}

          {/* Activity panel — side panel */}
          {showActivity && !showChat && (
            <div className="w-64 border-l border-border/20 bg-surface-50/30 overflow-y-auto flex flex-col shrink-0">
              <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/20 shrink-0">
                <History className="w-3 h-3 text-gray-500" />
                <span className="text-[10px] font-label uppercase tracking-wider text-gray-500">Activity</span>
                <span className="flex-1" />
                <button onClick={() => setShowActivity(false)} className="text-gray-600 hover:text-gray-300 p-0.5"><X className="w-3 h-3" /></button>
              </div>
              <ActivityTimeline activity={activity} />
            </div>
          )}

          {/* Chat panel — full-featured embedded chat */}
          {showChat && (
            <>
            <div onMouseDown={chatPanel.onMouseDown} className="w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-blue-500/30 active:bg-blue-500/50 transition-colors" />
            <div className="border-l border-border/20 bg-surface-50/30 flex flex-col shrink-0" style={{ width: chatPanel.size }}>
              <EmbeddedChat
                workspaceId={id!}
                workspaceName={workspace.name}
                worktreePath={workspace.worktreePath}
                linkedSessionId={workspace.chatSessionId}
                onClose={() => setShowChat(false)}
              />
            </div>
            </>
          )}
          </div>

          {/* Preview iframe — below editor (non-split) */}
          {showPreview && !splitPreview && (
            <div className="shrink-0 border-t border-border/30 flex flex-col" style={{ height: 300 }}>
              <PreviewBar id={id!} previewService={previewService} setPreviewService={setPreviewService} services={workspace.services} onClose={() => setShowPreview(false)} />
              <iframe src={`/api/workspaces/${id}/preview${previewService ? `?service=${previewService}` : ''}`} className="flex-1 w-full bg-white border-none" title="Preview" />
            </div>
          )}

          {/* Terminal resize handle */}
          {terminalVisible && <div onMouseDown={termPanel.onMouseDown} className="h-1 shrink-0 cursor-row-resize bg-transparent hover:bg-blue-500/30 active:bg-blue-500/50 transition-colors border-t border-border/30" />}

          {/* Terminal */}
          {terminalVisible && (
            <div className="shrink-0 flex flex-col overflow-hidden" style={{ height: termPanel.size }}>
              <div className="flex items-center gap-0 bg-surface-100/30 border-b border-border/20 shrink-0 px-1">
                {terminals.map(t => (
                  <div key={t.id} onClick={() => setActiveTerminal(t.id)}
                    className={`flex items-center gap-1 px-2.5 py-1 text-[10px] font-mono cursor-pointer border-b-2 ${activeTerminal === t.id ? 'border-blue-400 text-blue-400' : 'border-transparent text-gray-500 hover:text-gray-300'}`}>
                    <Terminal className="w-3 h-3" />{t.label}
                    {terminals.length > 1 && <button onClick={e => { e.stopPropagation(); closeTerminal(t.id); }} className="hover:text-red-400 ml-0.5"><X className="w-2.5 h-2.5" /></button>}
                  </div>
                ))}
                <button onClick={addTerminal} className="px-1.5 py-1 text-gray-600 hover:text-gray-300" title="New Terminal"><Plus className="w-3 h-3" /></button>
                <button onClick={addTerminal} className="px-1 py-1 text-gray-600 hover:text-gray-300" title="Split Terminal"><SplitSquareHorizontal className="w-3 h-3" /></button>
                <span className="flex-1" />
                <button onClick={() => setTerminalVisible(false)} className="text-gray-600 hover:text-gray-300 p-1"><X className="w-3 h-3" /></button>
              </div>
              <div className="flex-1 flex min-h-0">
                {terminals.map(t => (
                  <div key={t.id} className={`flex-1 min-h-0 ${terminals.length > 1 ? 'border-r border-border/20 last:border-r-0' : ''} ${activeTerminal === t.id || terminals.length > 1 ? '' : 'hidden'}`}>
                    <XTerminal workspaceId={id!} terminalId={t.id} className="h-full" />
                  </div>
                ))}
              </div>
            </div>
          )}

          {!terminalVisible && (
            <button onClick={() => setTerminalVisible(true)} className="border-t border-border/30 px-3 py-1 bg-surface-100/20 text-[10px] font-label uppercase tracking-wider text-gray-500 hover:text-gray-300 w-full text-left flex items-center gap-1.5 shrink-0">
              <Terminal className="w-3 h-3" /> Terminal
            </button>
          )}
        </div>
      </div>

      {/* Commit Modal */}
      {showCommitModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowCommitModal(false)}>
          <div className="bg-surface-100 border border-border/30 rounded-lg w-[480px] p-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-3">
              <GitCommit className="w-4 h-4 text-gray-400" />
              <span className="text-sm font-semibold text-white">Commit Changes</span>
              {changedCount > 0 && <span className="text-[10px] font-mono text-amber-400">{changedCount} changed</span>}
            </div>
            <textarea value={commitMsg} onChange={e => setCommitMsg(e.target.value)} placeholder="Commit message..." autoFocus rows={3}
              className="w-full bg-surface-50 border border-border/30 rounded px-3 py-2 text-sm font-mono text-gray-300 placeholder:text-gray-600 focus:outline-none focus:border-blue-500/50 resize-none" />
            <div className="flex items-center gap-2 mt-3 justify-end">
              <button onClick={() => setShowCommitModal(false)} className="btn-ghost text-xs py-1.5 px-3">Cancel</button>
              <button onClick={handleCommit} disabled={!commitMsg.trim() || committing} className="btn-primary text-xs py-1.5 px-4 disabled:opacity-50">
                {committing ? 'Committing...' : 'Commit'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* PR Modal */}
      {showPrModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowPrModal(false)}>
          <div className="bg-surface-100 border border-border/30 rounded-lg w-[520px] p-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-3">
              <GitPullRequest className="w-4 h-4 text-blue-400" />
              <span className="text-sm font-semibold text-white">Create Pull Request</span>
              <span className="text-[10px] font-mono text-gray-500">{workspace.branch} → {workspace.baseBranch}</span>
            </div>
            <input value={prTitle} onChange={e => setPrTitle(e.target.value)} placeholder="PR title..." autoFocus
              className="w-full bg-surface-50 border border-border/30 rounded px-3 py-2 text-sm text-gray-300 placeholder:text-gray-600 focus:outline-none focus:border-blue-500/50 mb-2" />
            <textarea value={prBody} onChange={e => setPrBody(e.target.value)} placeholder="Description (optional)..." rows={4}
              className="w-full bg-surface-50 border border-border/30 rounded px-3 py-2 text-sm font-mono text-gray-300 placeholder:text-gray-600 focus:outline-none focus:border-blue-500/50 resize-none" />
            <div className="flex items-center gap-2 mt-3 justify-end">
              <button onClick={() => setShowPrModal(false)} className="btn-ghost text-xs py-1.5 px-3">Cancel</button>
              <button onClick={handleCreatePR} disabled={!prTitle.trim() || creatingPr} className="btn-primary text-xs py-1.5 px-4 disabled:opacity-50 flex items-center gap-1">
                <GitPullRequest className="w-3.5 h-3.5" />
                {creatingPr ? 'Creating...' : 'Create PR'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Config Editor */}
      {showConfig && <WorkspaceConfigEditor repoId={workspace.repoId} onClose={() => { setShowConfig(false); load(); }} />}

      {workspace.setupProgress?.status === 'running' && (
        <div className="px-4 py-1.5 border-t border-border/30 bg-amber-400/5 shrink-0">
          <div className="flex items-center gap-2 text-xs">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-400" />
            <span className="text-amber-400 font-mono">Setting up ({workspace.setupProgress.currentStep}/{workspace.setupProgress.totalSteps})</span>
          </div>
        </div>
      )}
    </div>
  );
}
