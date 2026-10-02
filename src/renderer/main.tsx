import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { applyFontSize, fontSize } from './lib/font-size';
import './styles/globals.css';

const root = document.getElementById('root');
if (!root) throw new Error('renderer root element missing');

// Before the first render, so no screen is ever painted at one size and then another.
applyFontSize(fontSize());

createRoot(root).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
