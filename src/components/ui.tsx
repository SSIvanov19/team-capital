'use client';

import Link from 'next/link';
import {
  Calculator,
  ChartNoAxesCombined,
  Check,
  Code2,
  Copy,
  Headset,
  LoaderCircle,
  Workflow,
} from 'lucide-react';
import { useState } from 'react';
import type { RoleId } from '@/lib/types';

export function Brand({ light = false }: { light?: boolean }) {
  return (
    <Link className={'brand' + (light ? ' brand-light' : '')} href="/" aria-label="Team Capital home">
      Team Capital
    </Link>
  );
}

export function RoleIcon({ role, size = 22 }: { role: RoleId; size?: number }) {
  const Icon = {
    accountant: Calculator,
    analyst: ChartNoAxesCombined,
    developer: Code2,
    operations: Headset,
    coordinator: Workflow,
  }[role];
  return Icon ? <Icon size={size} aria-hidden="true" /> : null;
}

export function ErrorNotice({ message }: { message: string | null }) {
  return message ? <div className="error-notice" role="alert">{message}</div> : null;
}

export function Loading({ text = 'Connecting to your room…' }: { text?: string }) {
  return (
    <div className="loading-state" role="status">
      <LoaderCircle className="spin" size={22} aria-hidden="true" />
      <p>{text}</p>
    </div>
  );
}

export function CopyButton({ text, label = 'Copy link' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt('Copy this text', text);
    }
  }

  return (
    <button type="button" className="button button-ghost button-small" onClick={copy}>
      {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
      {copied ? 'Copied' : label}
    </button>
  );
}

