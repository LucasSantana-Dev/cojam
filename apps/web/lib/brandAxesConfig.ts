// Brand axes preview (#325 round 3). Config only (no React): safe for the
// server layout, the og routes and the client hooks in brandAxes.ts. Four independent root attributes on <html>,
// each set from a query param so every combination is linkable:
//   ?fx=current|flat  ?ground=black|indigo  ?presence=none|key|all
//   ?wordmark=text|lockup-a|lockup-b|lockup-c   (?preview=1 shows the switcher)
// Defaults reproduce the current site exactly: with no param and nothing stored
// the attributes are the defaults and every override is gated on a non-default
// value. The first-paint script (AXES_BOOT_SCRIPT) runs before hydration; React
// components read the attribute through useAxis, whose server snapshot is the
// default so SSR and the first client render agree.
export const AXES = {
  fx: ['current', 'flat'],
  ground: ['black', 'indigo'],
  presence: ['none', 'key', 'all'],
  wordmark: ['text', 'lockup-a', 'lockup-b', 'lockup-c'],
} as const;

export type AxisName = keyof typeof AXES;
export type AxisValue<A extends AxisName> = (typeof AXES)[A][number];

// `ground` has no neutral "current" value of its own: the shipped ground is the
// pre-existing surface tokens. `black` is the first listed value but the default
// is `current`-equivalent, so the default is a distinct sentinel.
export const AXIS_DEFAULTS = {
  fx: 'current',
  ground: 'default',
  presence: 'none',
  wordmark: 'text',
} as const;

export const AXIS_NAMES = Object.keys(AXES) as AxisName[];
export const STORAGE_KEY = 'cojam-brand-axes';

// Plain string so it can be inlined in <head>. Validates against the whitelist,
// falls back to sessionStorage (so in-app navigation keeps the combination),
// writes the attributes, and persists.
export const AXES_BOOT_SCRIPT = `(function(){try{
var A=${JSON.stringify(AXES)},D=${JSON.stringify(AXIS_DEFAULTS)},K=${JSON.stringify(STORAGE_KEY)};
var q=new URLSearchParams(location.search),s={};
try{s=JSON.parse(sessionStorage.getItem(K)||'{}')||{}}catch(e){}
var el=document.documentElement,any=false;
Object.keys(A).forEach(function(k){
var v=q.get(k);
if(v&&(A[k].indexOf(v)>-1||v===D[k])){s[k]=v;any=true}
var val=s[k];
if(!val||(A[k].indexOf(val)<0))val=D[k];
el.setAttribute('data-'+k,val);
});
var p=q.get('preview');
if(p==='1'){s.preview='1';any=true}else if(p==='0'){delete s.preview;any=true}
if(s.preview==='1')el.setAttribute('data-preview','1');
if(any)sessionStorage.setItem(K,JSON.stringify(s));
}catch(e){}})();`;

// Server-side parse for the og-preview route: same whitelist, same defaults.
export function parseAxes(params: URLSearchParams): Record<AxisName, string> {
  const out = { ...AXIS_DEFAULTS } as Record<AxisName, string>;
  for (const k of AXIS_NAMES) {
    const v = params.get(k);
    if (v && ((AXES[k] as readonly string[]).includes(v) || v === AXIS_DEFAULTS[k])) out[k] = v;
  }
  return out;
}
