import {
  ChevronLeft, ChevronRight, Plus, ArrowUp, Square, Paperclip, Mic, Volume2, History, SquarePen,
  Settings2, X, Trash2, Copy, Check, FileText, Image, Lock, Brain, Menu, LogOut, Sparkles, Users, Folder,
} from 'lucide-react';

const ICONS = {
  back: ChevronLeft, chevron: ChevronRight, plus: Plus, send: ArrowUp, stop: Square, clip: Paperclip,
  mic: Mic, speaker: Volume2, history: History, edit: SquarePen, gear: Settings2, x: X, trash: Trash2,
  copy: Copy, check: Check, file: FileText, image: Image, lock: Lock, brain: Brain, menu: Menu, logout: LogOut,
  sparkles: Sparkles, users: Users, folder: Folder,
};

export default function Icon({ name, size = 20, className = '' }) {
  const Cmp = ICONS[name];
  const filled = name === 'stop';
  return <Cmp size={size} strokeWidth={filled ? 0 : 1.75} fill={filled ? 'currentColor' : 'none'} className={className} aria-hidden="true" />;
}
