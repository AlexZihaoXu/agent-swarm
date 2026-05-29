'use client';

import { Input, Label } from '@heroui/react';
import { useState } from 'react';
import { LuEye, LuEyeOff } from 'react-icons/lu';

/** A labelled password input with a show/hide toggle (eye icon). */
export function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
  placeholder = '••••••••',
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="space-y-1.5">
      <Label className="text-sm">{label}</Label>
      <div className="relative">
        <Input
          type={show ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          placeholder={placeholder}
          autoFocus={autoFocus}
          className="pr-9"
        />
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          aria-label={show ? 'Hide password' : 'Show password'}
          className="text-muted hover:text-foreground focus-visible:text-foreground absolute inset-y-0 right-2 flex items-center focus-visible:outline-none"
        >
          {show ? <LuEyeOff className="size-4" /> : <LuEye className="size-4" />}
        </button>
      </div>
    </div>
  );
}
