import React from 'react';
import {getPersona} from './personas.js';

export function PersonaAvatar({id='solo',age=40,size='large'}) {
 const persona=getPersona(id)??getPersona('solo');
 const mature=age>=65;
 const hair=mature?'#96928b':persona.hair;
 const outfit=persona.outfit;
 const headId=`avatar-head-${persona.id}-${size}`;
 return <svg className={`persona-avatar avatar-${size}`} viewBox="0 0 160 180"
   role="img" aria-label={`${persona.short} 대표 캐릭터, ${age}세 장면`} xmlns="http://www.w3.org/2000/svg">
  <defs><clipPath id={headId}><circle cx="80" cy="87" r="36"/></clipPath></defs>
  <circle cx="80" cy="88" r="68" fill={persona.accent} opacity=".15"/>
  <circle cx="80" cy="88" r="56" fill="#fffefb" opacity=".85"/>
  <path d="M28 180c2-44 25-62 52-62s50 18 52 62" fill={outfit}/>
  <path d="m57 130 23 27 23-27-8-12H65Z" fill="#fff8e9" opacity=".9"/>
  <rect x="67" y="111" width="26" height="25" rx="10" fill="#d59b79"/>
  <circle cx="80" cy="85" r="35" fill="#e0ad8c"/>
  <g clipPath={`url(#${headId})`}>
   <path d="M41 78c-3-30 15-50 41-50 31 0 45 21 40 51l-5 2c-1-15-9-21-21-26-14 11-25 13-49 13l-1 16Z" fill={hair}/>
   {persona.id==='solo'&&<path d="M45 66c13-18 34-29 55-17" fill="none" stroke={hair} strokeWidth="14" strokeLinecap="round"/>}
   {persona.id==='couple'&&<path d="M53 47c25-13 49-2 60 15" fill="none" stroke={hair} strokeWidth="14" strokeLinecap="round"/>}
   {persona.id==='one-child'&&<path d="M61 47Q80 43 102 59" fill="none" stroke={hair} strokeWidth="17" strokeLinecap="round"/>}
   {persona.id==='two-children'&&<path d="M50 54Q86 28 114 58" fill="none" stroke={hair} strokeWidth="12" strokeLinecap="round"/>}
   {persona.id==='three-children'&&<path d="M50 68Q70 40 113 61" fill="none" stroke={hair} strokeWidth="13" strokeLinecap="round"/>}
  </g>
  <path d="M53 82v-9m54 9v-9" stroke={hair} strokeWidth="7" strokeLinecap="round" opacity=".9"/>
  <path d="M65 86h6m18 0h6" stroke="#504238" strokeWidth="3.3" strokeLinecap="round"/>
  <path d="M76 102q4 4 8 0" fill="none" stroke="#b47565" strokeWidth="2" strokeLinecap="round"/>
  {mature&&<g fill="none" stroke="#a57865" strokeWidth="1.4" opacity=".65"><path d="M56 95h8m32 0h8"/></g>}
  {persona.id==='couple'&&<path d="M58 78h20v16H58Zm24 0h20v16H82Zm-4 5h4" fill="none" stroke="#6c645f" strokeWidth="2" strokeLinejoin="round"/>}
  {persona.id==='two-children'&&<path d="M49 130q31 10 62 0" fill="none" stroke="#dae3ed" strokeWidth="4"/>}
  {persona.id==='three-children'&&<path d="M73 155v25m14-25v25" stroke="#e2d3ba" strokeWidth="3"/>}
  <circle cx="125" cy="39" r="12" fill="#fff" opacity=".95"/>
  <path d="M119 39h12m-6-6v12" stroke={persona.accent} strokeWidth="2" strokeLinecap="round"/>
 </svg>;
}
