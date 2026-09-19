import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from '../util/fs.mjs';
import { Raster } from './png.mjs';

const COLORS=['#176B87','#64CCC5','#DAA520','#8B5CF6','#D95D39','#2F855A','#C24173','#4A5568'];
function esc(s){return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');}
function niceMax(v){if(v<=0)return 1;const p=10**Math.floor(Math.log10(v));const n=v/p;return(n<=1?1:n<=2?2:n<=5?5:10)*p;}

function svgBase(title,body,width=1200,height=700){return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#FAFAF8"/><style>text{font-family:Inter,Segoe UI,Arial,sans-serif;fill:#16212B}.title{font-size:30px;font-weight:700}.label{font-size:15px;fill:#52606D}.tick{font-size:13px;fill:#667784}.grid{stroke:#DDE3E7;stroke-width:1}.axis{stroke:#72808A;stroke-width:1.5}</style><text x="72" y="54" class="title">${esc(title)}</text>${body}</svg>`;}

export function barChart({title,labels,values,fileBase,yLabel='',colors=COLORS,width=1200,height=700}){
  ensureDir(path.dirname(fileBase));const L=90,R=40,T=90,B=120,W=width-L-R,H=height-T-B;const max=niceMax(Math.max(...values,1));let body='';
  for(let i=0;i<=5;i++){const y=T+H-i*H/5;body+=`<line class="grid" x1="${L}" y1="${y}" x2="${L+W}" y2="${y}"/><text class="tick" x="${L-12}" y="${y+5}" text-anchor="end">${(max*i/5).toFixed(max<10?1:0)}</text>`;}
  const gap=W/labels.length,bw=Math.max(6,gap*.68);values.forEach((v,i)=>{const h=H*v/max,x=L+i*gap+(gap-bw)/2,y=T+H-h;body+=`<rect x="${x}" y="${y}" width="${bw}" height="${h}" rx="4" fill="${colors[i%colors.length]}"/><text class="label" x="${L+(i+.5)*gap}" y="${T+H+26}" text-anchor="middle" transform="rotate(35 ${L+(i+.5)*gap} ${T+H+26})">${esc(labels[i])}</text>`;});
  body+=`<line class="axis" x1="${L}" y1="${T+H}" x2="${L+W}" y2="${T+H}"/><text class="label" transform="rotate(-90 24 ${T+H/2})" x="24" y="${T+H/2}" text-anchor="middle">${esc(yLabel)}</text>`;
  fs.writeFileSync(`${fileBase}.svg`,svgBase(title,body,width,height));
  const r=new Raster(width,height);r.text(72,24,title,[22,33,43,255],3);for(let i=0;i<=5;i++){const y=T+H-i*H/5;r.line(L,y,L+W,y,[221,227,231,255]);r.text(20,y-7,(max*i/5).toFixed(max<10?1:0),[82,96,109,255],2);}values.forEach((v,i)=>{const h=H*v/max,x=L+i*gap+(gap-bw)/2,y=T+H-h;const hex=colors[i%colors.length];const c=[parseInt(hex.slice(1,3),16),parseInt(hex.slice(3,5),16),parseInt(hex.slice(5,7),16),255];r.rect(x,y,bw,h,c);r.text(x,T+H+16,labels[i].slice(0,10),[70,80,90,255],1);});r.line(L,T+H,L+W,T+H,[80,90,100,255],2);r.save(`${fileBase}.png`);
}

export function lineChart({title,series,fileBase,xLabel='',yLabel='',width=1200,height=700}){
  ensureDir(path.dirname(fileBase));const L=90,R=40,T=90,B=80,W=width-L-R,H=height-T-B;const all=series.flatMap(s=>s.values);let min=Math.min(...all),max=Math.max(...all);if(min===max){min-=1;max+=1;}const pad=(max-min)*.06;min-=pad;max+=pad;let body='';
  for(let i=0;i<=5;i++){const y=T+H-i*H/5,val=min+(max-min)*i/5;body+=`<line class="grid" x1="${L}" y1="${y}" x2="${L+W}" y2="${y}"/><text class="tick" x="${L-12}" y="${y+5}" text-anchor="end">${val.toFixed(Math.abs(max-min)<2?3:1)}</text>`;}
  series.forEach((s,si)=>{const pts=s.values.map((v,i)=>`${L+(s.values.length===1?0:i*W/(s.values.length-1))},${T+H-(v-min)*H/(max-min)}`).join(' ');body+=`<polyline points="${pts}" fill="none" stroke="${COLORS[si%COLORS.length]}" stroke-width="3"/>`;body+=`<text class="label" x="${L+20+si*180}" y="${height-24}" fill="${COLORS[si%COLORS.length]}">● ${esc(s.label)}</text>`;});
  body+=`<line class="axis" x1="${L}" y1="${T+H}" x2="${L+W}" y2="${T+H}"/><text class="label" x="${L+W/2}" y="${height-48}" text-anchor="middle">${esc(xLabel)}</text><text class="label" transform="rotate(-90 24 ${T+H/2})" x="24" y="${T+H/2}" text-anchor="middle">${esc(yLabel)}</text>`;
  fs.writeFileSync(`${fileBase}.svg`,svgBase(title,body,width,height));
  const r=new Raster(width,height);r.text(72,24,title,[22,33,43,255],3);for(let i=0;i<=5;i++){const y=T+H-i*H/5;r.line(L,y,L+W,y,[221,227,231,255]);r.text(10,y-7,(min+(max-min)*i/5).toFixed(1),[82,96,109,255],1);}series.forEach((s,si)=>{const hex=COLORS[si%COLORS.length],c=[parseInt(hex.slice(1,3),16),parseInt(hex.slice(3,5),16),parseInt(hex.slice(5,7),16),255];for(let i=1;i<s.values.length;i++){const x0=L+(i-1)*W/(s.values.length-1),x1=L+i*W/(s.values.length-1),y0=T+H-(s.values[i-1]-min)*H/(max-min),y1=T+H-(s.values[i]-min)*H/(max-min);r.line(x0,y0,x1,y1,c,2);}r.text(L+si*190,height-28,s.label.slice(0,20),c,1);});r.save(`${fileBase}.png`);
}

export function heatmap({title,matrix,rowLabels,colLabels,fileBase,width=1200,height=700}){
  ensureDir(path.dirname(fileBase));const L=160,R=50,T=100,B=90,W=width-L-R,H=height-T-B;const rows=matrix.length,cols=matrix[0]?.length||0;const vals=matrix.flat().filter(Number.isFinite),min=Math.min(...vals),max=Math.max(...vals);let body='';
  for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){const v=matrix[r][c],q=Number.isFinite(v)&&max>min?(v-min)/(max-min):0;const rr=Math.round(240-170*q),gg=Math.round(245-115*q),bb=Math.round(245-65*q);body+=`<rect x="${L+c*W/cols}" y="${T+r*H/rows}" width="${W/cols+1}" height="${H/rows+1}" fill="rgb(${rr},${gg},${bb})"/>`;}
  rowLabels.forEach((x,i)=>body+=`<text class="tick" x="${L-12}" y="${T+(i+.65)*H/rows}" text-anchor="end">${esc(x)}</text>`);colLabels.forEach((x,i)=>body+=`<text class="tick" x="${L+(i+.5)*W/cols}" y="${T+H+24}" text-anchor="middle">${esc(x)}</text>`);
  fs.writeFileSync(`${fileBase}.svg`,svgBase(title,body,width,height));
  const ras=new Raster(width,height);ras.text(72,24,title,[22,33,43,255],3);for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){const v=matrix[r][c],q=Number.isFinite(v)&&max>min?(v-min)/(max-min):0;ras.rect(L+c*W/cols,T+r*H/rows,W/cols+1,H/rows+1,[Math.round(240-170*q),Math.round(245-115*q),Math.round(245-65*q),255]);}ras.save(`${fileBase}.png`);
}

export function architectureSvg(file,title,lines){const width=1200,height=160+lines.length*100;let body='';lines.forEach((line,i)=>{const y=100+i*100;body+=`<rect x="170" y="${y}" width="860" height="64" rx="12" fill="${i%2?'#E8F4F4':'#E9EFF4'}" stroke="#9FB4C2"/><text x="600" y="${y+39}" text-anchor="middle" font-size="20" font-weight="600">${esc(line)}</text>`;if(i<lines.length-1)body+=`<path d="M600 ${y+64} V${y+96}" stroke="#587384" stroke-width="3"/><path d="M592 ${y+88} L600 ${y+98} L608 ${y+88}" fill="none" stroke="#587384" stroke-width="3"/>`;});ensureDir(path.dirname(file));fs.writeFileSync(file,svgBase(title,body,width,height));}
