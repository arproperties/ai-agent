import {
  Bot, Sparkles, Building2, PenLine, GraduationCap, Dumbbell, Briefcase, Code2, Scale, Stethoscope,
  Plane, ChefHat, Brain, Heart, Wallet, ShoppingBag, Megaphone, Camera, Globe, Rocket, Headset,
  Home, Calculator, Users,
} from 'lucide-react';

export const AGENT_ICONS = {
  bot: Bot, sparkles: Sparkles, building: Building2, home: Home, briefcase: Briefcase, headset: Headset,
  users: Users, pen: PenLine, megaphone: Megaphone, graduation: GraduationCap, brain: Brain, code: Code2, calculator: Calculator,
  wallet: Wallet, scale: Scale, stethoscope: Stethoscope, dumbbell: Dumbbell, heart: Heart, chef: ChefHat,
  plane: Plane, shopping: ShoppingBag, camera: Camera, globe: Globe, rocket: Rocket,
};

export const AGENT_COLORS = {
  violet: 'from-violet-400 to-fuchsia-500 shadow-violet-500/30',
  blue: 'from-sky-400 to-indigo-500 shadow-sky-500/30',
  teal: 'from-emerald-400 to-cyan-500 shadow-emerald-500/30',
  amber: 'from-amber-300 to-orange-500 shadow-amber-500/30',
  rose: 'from-rose-400 to-pink-600 shadow-rose-500/30',
  slate: 'from-slate-400 to-slate-600 shadow-slate-500/30',
};

export default function Avatar({ icon, color, size = 48, className = '' }) {
  const Cmp = AGENT_ICONS[icon] || Bot;
  return (
    <span style={{ width: size, height: size }}
      className={`grid shrink-0 place-items-center rounded-full bg-gradient-to-br text-white shadow-lg ${AGENT_COLORS[color] || AGENT_COLORS.violet} ${className}`}>
      <Cmp size={Math.round(size * 0.46)} strokeWidth={1.75} />
    </span>
  );
}
