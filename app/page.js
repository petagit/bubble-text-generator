'use client';

import { useEffect } from 'react';
import { initApp } from './main.mjs';
import { AppMarkup } from './ui.js';

export default function Page() {
  useEffect(initApp, []);
  return <AppMarkup />;
}
