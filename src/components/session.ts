'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Command, LeaveResult, Snapshot } from '@/lib/types';

export type SessionSnapshot = Snapshot & {host?:{projectorToken:string;joinUrl:string;projectorUrl:string}};
type WithoutAction<T> = T extends unknown ? Omit<T,'actionId'> : never;
export type CommandInput = WithoutAction<Command>;
export class RequestError extends Error { constructor(message:string,readonly status:number,readonly code?:string){super(message);} }

interface ResponseTicket { epoch:number; id:number }
const phaseOrder:Record<Snapshot['phase'],number>={lobby:0,decision:1,reveal:2,finished:3,ended:4,expired:5};
function compareSnapshots(next:SessionSnapshot,previous:SessionSnapshot):number {
  return next.serverNow-previous.serverNow
    || next.round-previous.round
    || phaseOrder[next.phase]-phaseOrder[previous.phase]
    || (next.myVote?.revision??0)-(previous.myVote?.revision??0);
}

/** Orders all successful responses and invalidates in-flight data after an access denial. */
export class SessionResponseGuard {
  private epoch=0;
  private sequence=0;
  private accepted:SessionSnapshot|null=null;
  private acceptedRequest=0;
  begin():ResponseTicket {return {epoch:this.epoch,id:++this.sequence};}
  isCurrent(ticket:ResponseTicket):boolean {return ticket.epoch===this.epoch;}
  isRelevantFailure(ticket:ResponseTicket):boolean {return this.isCurrent(ticket)&&ticket.id>=this.acceptedRequest;}
  accept(ticket:ResponseTicket,next:SessionSnapshot):boolean {
    if(!this.isCurrent(ticket))return false;
    if(this.accepted){
      const order=compareSnapshots(next,this.accepted);
      if(order<0||(order===0&&ticket.id<this.acceptedRequest))return false;
    }
    this.accepted=next;this.acceptedRequest=ticket.id;
    return true;
  }
  invalidate():void {this.epoch+=1;this.accepted=null;this.acceptedRequest=0;}
  depart(ticket:ResponseTicket,expectedPlayerId:string):boolean {
    if(!this.isCurrent(ticket))return false;
    if(this.accepted?.player && this.accepted.player.id!==expectedPlayerId)return false;
    this.invalidate();
    return true;
  }
  deny(ticket:ResponseTicket):boolean {
    if(!this.isCurrent(ticket))return false;
    this.invalidate();return true;
  }
}
export function isAccessDenial(error:unknown):error is RequestError {
  return error instanceof RequestError&&([401,403,410].includes(error.status)||(error.status===404&&error.code!=='team_not_found')||(error.status===409&&error.code==='game_updated'));
}
function newActionId():string {
  // getRandomValues also works on classroom LANs served over plain HTTP.
  return Array.from(crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,'0')).join('');
}
export async function request<T>(url:string,body?:unknown):Promise<T> {
  const response=await fetch(url,{method:body===undefined?'GET':'POST',headers:body===undefined?undefined:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',signal:AbortSignal.timeout(10000)});
  const data=await response.json();
  if(!response.ok)throw new RequestError(data.message||'The request could not be completed.',response.status,data.error);
  return data;
}
export function useSession(code:string,view:'host'|'player'|'projector',token?:string) {
  const [snapshot,setSnapshot]=useState<SessionSnapshot|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [offline,setOffline]=useState(false);
  const [busy,setBusy]=useState(false);
  const [left,setLeft]=useState(false);
  const leavingPlayerId=useRef<string|null>(null);
  const departureIntent=useRef<string|null>(null);
  const changingTeam=useRef(false);
  const guard=useRef(new SessionResponseGuard());
  const commandLock=useRef<number|null>(null);
  const seen=useRef(false);
  const invalidate=useCallback(()=>{guard.current.invalidate();},[]);
  const completeDeparture=useCallback((ticket:ResponseTicket,expectedPlayerId:string):boolean=>{
    if(!guard.current.depart(ticket,expectedPlayerId))return false;
    commandLock.current=null;
    departureIntent.current=null;
    leavingPlayerId.current=expectedPlayerId;
    setSnapshot(null);setOffline(false);setBusy(false);setError(null);setLeft(true);
    return true;
  },[]);
  const denyAccess=useCallback((ticket:ResponseTicket,e:RequestError)=>{
    if(!guard.current.deny(ticket))return;
    seen.current=false;commandLock.current=null;
    setSnapshot(null);setOffline(true);setBusy(false);setError(e.message);
  },[]);
  const url=`/api/rooms/${encodeURIComponent(code)}/state?view=${view}${token?`&token=${encodeURIComponent(token)}`:''}`;
  const refresh=useCallback(async()=>{
    if(leavingPlayerId.current!==null||changingTeam.current)return;
    const ticket=guard.current.begin();
    try {
      const next=await request<SessionSnapshot>(url);
      if(guard.current.accept(ticket,next)){
        if(departureIntent.current!==null&&next.player?.id!==departureIntent.current)departureIntent.current=null;
        setSnapshot(next);setOffline(false);if(!seen.current)setError(null);seen.current=true;
      }
    }
    catch(e){
      if(e instanceof RequestError&&e.status===401&&departureIntent.current!==null){
        if(completeDeparture(ticket,departureIntent.current))return;
      }
      if(isAccessDenial(e)){denyAccess(ticket,e);return;}
      if(guard.current.isRelevantFailure(ticket)){setOffline(true);if(!seen.current)setError(e instanceof Error?e.message:'Connection failed.');}
    }
  },[url,denyAccess,completeDeparture]);
  useEffect(()=>{
    let cancelled=false,active=false;
    const poll=async()=>{if(active||cancelled)return;active=true;await refresh();active=false;};
    void poll();const timer=setInterval(poll,1000);window.addEventListener('focus',poll);window.addEventListener('online',poll);
    return()=>{cancelled=true;clearInterval(timer);invalidate();window.removeEventListener('focus',poll);window.removeEventListener('online',poll);};
  },[refresh,invalidate]);
  async function command(input:CommandInput) {
    if(commandLock.current!==null||leavingPlayerId.current!==null||left)return false;
    const isLeaving=input.type==='leave';
    const isChangingTeam=input.type==='change_team';
    if(isChangingTeam){
      // A same-millisecond old poll must not restore the previous team.
      guard.current.invalidate();
      changingTeam.current=true;
    }
    if(isLeaving){
      // Ignore requests begun before this departure, including revoked-cookie polls.
      guard.current.invalidate();
      leavingPlayerId.current=input.expectedPlayerId;
      departureIntent.current=input.expectedPlayerId;
    }
    const ticket=guard.current.begin();
    commandLock.current=ticket.id;setBusy(true);setError(null);
    let departed=false;
    try {
      const next=await request<SessionSnapshot|LeaveResult>('/api/rooms/'+encodeURIComponent(code)+'/commands?view='+view,{
        ...input,actionId:newActionId(),round:snapshot?.round,phase:snapshot?.phase,
      });
      if('left' in next){
        if(!isLeaving)throw new Error('The session changed. Refresh before trying again.');
        departed=completeDeparture(ticket,input.expectedPlayerId);
        return departed;
      }
      if(guard.current.accept(ticket,next)){setSnapshot(next);setOffline(false);seen.current=true;}
      return guard.current.isCurrent(ticket);
    }catch(e){
      // A completed leave may revoke authentication before an acknowledgement.
      // Do not retry it: the next join will have a different player identity.
      if(isLeaving&&e instanceof RequestError&&e.status===401){
        departed=completeDeparture(ticket,input.expectedPlayerId);
        return departed;
      }
      if(isLeaving&&e instanceof RequestError&&e.status<500)departureIntent.current=null;
      if(isAccessDenial(e)){denyAccess(ticket,e);return false;}
      if(guard.current.isCurrent(ticket)){
        setError(e instanceof Error?e.message:'Your action was not saved. Please try again.');
        if(!isLeaving&&!isChangingTeam)void refresh();
      }
      return false;
    }finally{
      if(isChangingTeam){
        changingTeam.current=false;
        if(guard.current.isCurrent(ticket))void refresh();
      }
      if(isLeaving&&!departed){
        leavingPlayerId.current=null;
        if(guard.current.isCurrent(ticket))void refresh();
      }
      if(commandLock.current===ticket.id){commandLock.current=null;setBusy(false);}
    }
  }
  return {snapshot,error,setError,offline,busy,left,command,refresh};
}
