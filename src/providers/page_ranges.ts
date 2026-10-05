import {ProviderError} from './transport.js';

export interface PageRange {start:number;end:number;}
// Bound work by the textual request and interval count, never its page extent.
export const MAX_PAGE_RANGE_TEXT=16*1024;
export const MAX_PAGE_RANGE_PARTS=1024;

/** Inclusive positive intervals. The original request text remains its identity. */
export function parsePageRanges(pages:string|undefined):PageRange[]|null {
 if(pages===undefined)return null;
 if(typeof pages!=='string'||!pages||pages.length>MAX_PAGE_RANGE_TEXT)throw new ProviderError('invalid_page_ranges');
 const parts=pages.split(',');
 if(parts.length>MAX_PAGE_RANGE_PARTS)throw new ProviderError('invalid_page_ranges');
 const intervals=parts.map(part=>{
  if(!/^\d+(?:-\d+)?$/.test(part))throw new ProviderError('invalid_page_ranges');
  const [first,last]=part.split('-'),start=Number(first),end=last===undefined?start:Number(last);
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<1||end<start)throw new ProviderError('invalid_page_ranges');
  return{start,end};
 }).sort((a,b)=>a.start-b.start||a.end-b.end);
 const normalized:PageRange[]=[];
 for(const interval of intervals){
  const previous=normalized.at(-1);
  if(previous&&interval.start<=previous.end+1)previous.end=Math.max(previous.end,interval.end);
  else normalized.push(interval);
 }
 return normalized;
}
