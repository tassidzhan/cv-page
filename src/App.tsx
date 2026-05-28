import { useEffect, useState, useMemo, useRef } from 'react';
import Papa from 'papaparse';
import { differenceInDays, parseISO, isValid, max, format, getYear } from 'date-fns';
import { Award, Briefcase, Users, X, Settings2, Plus, Trash2 } from 'lucide-react';
import { ORGANIZATION_COLORS, DEFAULT_ORGANIZATION_COLOR, NEW_ORGANIZATION_DEFAULT_COLOR } from './constants/organizationColors';

interface EventRecord {
  name: string;
  organisation: string;
  type: string;
  start_date: string;
  end_date: string;
  description: string;
}

interface SubEvent {
  startDate: Date;
  endDate: Date;
  description: string;
}

interface ParsedEvent extends Omit<EventRecord, 'start_date' | 'end_date' | 'description'> {
  id: number;
  startDate: Date;
  endDate: Date;
  subEvents: SubEvent[];
  durationDays: number;
  leftOffsetPixels: number;
  topOffsetPixels: number;
  widthPixels: number;
  lane: number;
}

interface LaneGroupDef {
  label: string;
  startLane: number;
  laneCount: number;
}

export default function App() {
  const [rawEvents, setRawEvents] = useState<EventRecord[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [grouping, setGrouping] = useState<'none' | 'organisation' | 'type'>('none');
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Settings State
  const [showSettings, setShowSettings] = useState(false);
  const [pixelsPerDay, setPixelsPerDay] = useState(1.2);
  const [laneHeight, setLaneHeight] = useState(44);
  const [colors, setColors] = useState<Record<string, string>>(ORGANIZATION_COLORS);
  
  // New org color state form
  const [newOrgName, setNewOrgName] = useState('');
  const [newOrgColor, setNewOrgColor] = useState(NEW_ORGANIZATION_DEFAULT_COLOR);

  useEffect(() => {
    const fetchCSV = async () => {
      try {
        const basePath = import.meta.env.BASE_URL || '/';
        const res = await fetch(`${basePath}data.csv`);
        if (!res.ok) throw new Error('Failed to load data.csv');
        const text = await res.text();
        Papa.parse<EventRecord>(text, {
          header: true,
          skipEmptyLines: true,
          complete: (results) => {
            setRawEvents(results.data);
          },
          error: (err: any) => setLoadError(err.message),
        });
      } catch (e: any) {
        setLoadError(e.message);
      }
    };
    fetchCSV();
  }, []);

  const searchParams = new URLSearchParams(window.location.search);
  const showHidden = searchParams.has('show_all') || searchParams.get('mode') === 'full';

  const { events, laneGroups, maxLanes, timelineWidth, years } = useMemo(() => {
    if (!rawEvents.length) return { events: [], laneGroups: [], maxLanes: 0, timelineWidth: 1000, years: [] };

    const baseEvents = rawEvents
      .filter(item => {
        const org = item.organisation?.toLowerCase() || '';
        return showHidden || (org !== 'stf' && org !== 'hankkijat');
      })
      .map((item, idx) => {
      let st = parseISO(item.start_date);
      if (!isValid(st)) st = new Date();
      let ed = item.end_date ? parseISO(item.end_date) : st;
      if (!isValid(ed)) ed = st;
      return { ...item, id: idx, startDate: st, endDate: ed };
    });

    baseEvents.sort((a, b) => a.startDate.getTime() - b.startDate.getTime());

    // Compute dynamic start date
    const earliestStartDate = new Date(baseEvents[0].startDate);
    earliestStartDate.setMonth(earliestStartDate.getMonth() - 1);
    const dynamicStartDate = earliestStartDate;

    const mergedEvents: any[] = [];
    for (const ev of baseEvents) {
      const groupIdx = mergedEvents.findIndex(g => 
        g.name === ev.name && 
        g.organisation === ev.organisation && 
        g.type === ev.type &&
        differenceInDays(ev.startDate, g.endDate) <= 31
      );

      if (groupIdx !== -1) {
        const g = mergedEvents[groupIdx];
        g.subEvents.push({ startDate: ev.startDate, endDate: ev.endDate, description: ev.description });
        if (ev.endDate > g.endDate) g.endDate = ev.endDate;
      } else {
        mergedEvents.push({
          id: ev.id,
          name: ev.name,
          organisation: ev.organisation,
          type: ev.type,
          startDate: ev.startDate,
          endDate: ev.endDate,
          subEvents: [{ startDate: ev.startDate, endDate: ev.endDate, description: ev.description }]
        });
      }
    }

    const processed: ParsedEvent[] = [];
    let currentAbsoluteLane = 0;
    const computedLaneGroups: LaneGroupDef[] = [];

    // Process decorations
    const decorEvents = mergedEvents.filter(e => e.type === 'decoration');
    if (decorEvents.length > 0) {
      const decorLanes: {start: number, end: number}[][] = [];
      for (const ev of decorEvents) {
        let assignedLane = 0;
        for (let i = 0; i < decorLanes.length; i++) {
          let hasOverlap = false;
          for (const interval of decorLanes[i]) {
            const evStart = ev.startDate.getTime();
            const evEnd = ev.endDate.getTime() > ev.startDate.getTime() ? ev.endDate.getTime() : ev.startDate.getTime();
            const bufferMs = 60 * 24 * 60 * 60 * 1000; 
            if (evStart < interval.end + bufferMs && evEnd > interval.start - bufferMs) {
               hasOverlap = true; break;
            }
          }
          if (!hasOverlap) { assignedLane = i; break; }
          assignedLane = i + 1;
        }
        if (!decorLanes[assignedLane]) decorLanes[assignedLane] = [];
        const st = Math.max(ev.startDate.getTime(), dynamicStartDate.getTime());
        decorLanes[assignedLane].push({ start: st, end: st });
        
        const relativeDaysStart = differenceInDays(ev.startDate, dynamicStartDate);
        processed.push({
          ...ev,
          lane: currentAbsoluteLane + assignedLane,
          durationDays: 0,
          leftOffsetPixels: relativeDaysStart * pixelsPerDay,
          topOffsetPixels: (currentAbsoluteLane + assignedLane) * laneHeight,
          widthPixels: 36,
        });
      }
      computedLaneGroups.push({ label: 'Decorations', startLane: currentAbsoluteLane, laneCount: decorLanes.length });
      currentAbsoluteLane += decorLanes.length;
    }

    // Process standard roles
    const roleEvents = mergedEvents.filter(e => e.type !== 'decoration');
    roleEvents.sort((a, b) => {
      const durA = Math.max(0, a.endDate.getTime() - a.startDate.getTime());
      const durB = Math.max(0, b.endDate.getTime() - b.startDate.getTime());
      if (durB !== durA) return durB - durA; 
      return a.startDate.getTime() - b.startDate.getTime();
    });

    const processEntityGroup = (label: string, eventsSubset: any[]) => {
      const localRoleLanes: {start: number, end: number}[][] = [];
      for (const ev of eventsSubset) {
        let assignedLane = 0;
        for (let i = 0; i < localRoleLanes.length; i++) {
          let hasOverlap = false;
          for (const interval of localRoleLanes[i]) {
            const evStart = ev.startDate.getTime();
            const evEnd = ev.endDate.getTime() > ev.startDate.getTime() ? ev.endDate.getTime() : ev.startDate.getTime();
            const bufferMs = 15 * 24 * 60 * 60 * 1000;
            if (evStart < interval.end + bufferMs && evEnd > interval.start - bufferMs) {
               hasOverlap = true; break;
            }
          }
          if (!hasOverlap) { assignedLane = i; break; }
          assignedLane = i + 1;
        }
        if (!localRoleLanes[assignedLane]) localRoleLanes[assignedLane] = [];
        const st = Math.max(ev.startDate.getTime(), dynamicStartDate.getTime());
        localRoleLanes[assignedLane].push({ start: st, end: ev.endDate.getTime() > st ? ev.endDate.getTime() : st });

        const relativeDaysStart = differenceInDays(ev.startDate, dynamicStartDate);
        let rawDuration = differenceInDays(ev.endDate, ev.startDate);
        if (rawDuration < 0) rawDuration = 0;

        const absoluteLaneIdx = currentAbsoluteLane + assignedLane;
        processed.push({
          ...ev,
          lane: absoluteLaneIdx,
          durationDays: rawDuration,
          leftOffsetPixels: relativeDaysStart * pixelsPerDay,
          topOffsetPixels: absoluteLaneIdx * laneHeight,
          widthPixels: Math.max(rawDuration * pixelsPerDay, 80), // Set base min width to 80px to safely fit small items
        });
      }
      if (localRoleLanes.length > 0) {
        computedLaneGroups.push({ label, startLane: currentAbsoluteLane, laneCount: localRoleLanes.length });
        currentAbsoluteLane += localRoleLanes.length;
      }
    };

    if (grouping === 'none') {
      processEntityGroup('Roles & Groups', roleEvents);
    } else {
      let distinctKeys = Array.from(new Set(roleEvents.map(e => e[grouping] as string)));
      
      if (grouping === 'organisation') {
         const order = ['tf', 'ayy', 'teekkarius', 'stf', 'hankkijat'];
         distinctKeys.sort((a, b) => {
            const aStr = String(a).toLowerCase();
            const bStr = String(b).toLowerCase();
            const aIdx = order.indexOf(aStr);
            const bIdx = order.indexOf(bStr);
            if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
            if (aIdx !== -1) return -1;
            if (bIdx !== -1) return 1;
            return aStr.localeCompare(bStr);
         });
      } else {
         distinctKeys.sort();
      }

      for (const key of distinctKeys) {
        processEntityGroup(key.toUpperCase(), roleEvents.filter(e => e[grouping] === key));
      }
    }

    const maxDate = max(processed.map(e => e.endDate));
    const finalTimelineWidth = differenceInDays(maxDate, dynamicStartDate) * pixelsPerDay + 400;
    
    const yList = [];
    const maxYear = getYear(maxDate) + 1;
    const startYear = getYear(dynamicStartDate);
    for (let y = startYear; y <= maxYear; y++) {
       const dateObj = new Date(`${y}-01-01`);
       const days = differenceInDays(dateObj, dynamicStartDate);
       if (days >= 0) yList.push({ year: y, left: days * pixelsPerDay });
    }

    return { events: processed, laneGroups: computedLaneGroups, maxLanes: currentAbsoluteLane, timelineWidth: finalTimelineWidth, years: yList };
  }, [rawEvents, grouping, pixelsPerDay, laneHeight]);

  const closeExpanded = (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setExpandedId(null);
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
         closeExpanded();
         setShowSettings(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  if (loadError) return <div className="p-8 text-red-500">Error: {loadError}</div>;
  if (!events.length && rawEvents.length === 0) return <div className="p-8 text-slate-400 text-center mt-10">Loading timeline...</div>;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 flex flex-col font-sans overflow-hidden" onClick={closeExpanded}>
      {/* Settings Modal Layer */}
      {showSettings && (
         <div className="fixed inset-0 z-[100] flex justify-end bg-black/20 backdrop-blur-sm transition-opacity" onClick={() => setShowSettings(false)}>
           <div className="w-80 md:w-96 bg-white h-full shadow-2xl overflow-y-auto p-6 animate-in slide-in-from-right" onClick={e => e.stopPropagation()}>
              <div className="flex justify-between items-center mb-8 border-b pb-4">
                 <h2 className="text-xl font-bold text-slate-800">Timeline Settings</h2>
                 <button onClick={() => setShowSettings(false)} className="text-slate-500 hover:bg-slate-100 p-2 rounded-full transition-colors"><X size={20}/></button>
              </div>

              <div className="space-y-8">
                 <div>
                   <div className="flex justify-between mb-1">
                     <label className="text-sm font-semibold text-slate-700">Pixels Per Day (Scale)</label>
                     <span className="text-xs font-mono bg-slate-100 px-2 py-0.5 rounded text-slate-600">{pixelsPerDay.toFixed(1)}x</span>
                   </div>
                   <input type="range" min="0.1" max="5.0" step="0.1" value={pixelsPerDay} onChange={e => setPixelsPerDay(parseFloat(e.target.value))} className="w-full accent-slate-800" />
                 </div>
                 
                 <div>
                   <div className="flex justify-between mb-1">
                     <label className="text-sm font-semibold text-slate-700">Lane Height</label>
                     <span className="text-xs font-mono bg-slate-100 px-2 py-0.5 rounded text-slate-600">{laneHeight}px</span>
                   </div>
                   <input type="range" min="20" max="100" step="1" value={laneHeight} onChange={e => setLaneHeight(parseInt(e.target.value))} className="w-full accent-slate-800" />
                 </div>

                 <div className="pt-6 border-t border-slate-100">
                   <label className="block text-sm font-semibold text-slate-700 mb-3">Organization Colors</label>
                   <div className="space-y-3 max-h-64 overflow-y-auto pr-2 custom-scrollbar">
                     {Object.entries(colors)
                       .filter(([org]) => showHidden || (org !== 'stf' && org !== 'hankkijat'))
                       .map(([org, color]) => (
                        <div key={org} className="flex justify-between items-center bg-slate-50 p-2 rounded border border-slate-100">
                           <span className="text-sm font-medium text-slate-700 truncate pr-2 capitalize" title={org}>{org}</span>
                           <div className="flex items-center gap-3">
                               <input type="color" value={color} onChange={e => setColors(prev => ({...prev, [org]: e.target.value}))} className="w-6 h-6 p-0 border-0 rounded cursor-pointer" />
                               <button 
                                 onClick={() => {
                                   const newColors = {...colors};
                                   delete newColors[org];
                                   setColors(newColors);
                                 }} 
                                 className="text-slate-400 hover:text-red-500 transition-colors"
                                 title="Remove color"
                               >
                                 <Trash2 size={14}/>
                               </button>
                           </div>
                        </div>
                     ))}
                   </div>
                 </div>

                 <div className="pt-2">
                    <label className="block text-xs font-semibold text-slate-500 mb-2 uppercase tracking-wider">Add New Organization Color</label>
                    <div className="flex items-center gap-2">
                       <input 
                         type="text" 
                         placeholder="Org Name" 
                         value={newOrgName} 
                         onChange={e => setNewOrgName(e.target.value.toLowerCase())} 
                         className="flex-1 border border-slate-300 rounded px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-slate-200" 
                       />
                       <input 
                         type="color" 
                         value={newOrgColor} 
                         onChange={e => setNewOrgColor(e.target.value)} 
                         className="w-8 h-8 p-0 border-0 rounded cursor-pointer shrink-0" 
                       />
                       <button 
                         onClick={() => {
                           if (newOrgName.trim()) {
                               setColors(prev => ({...prev, [newOrgName.trim()]: newOrgColor}));
                               setNewOrgName('');
                           }
                         }} 
                         className="bg-slate-800 text-white p-1.5 rounded hover:bg-slate-700 shadow-sm shrink-0"
                         title="Add rule"
                       >
                         <Plus size={18}/>
                       </button>
                    </div>
                 </div>
              </div>
           </div>
         </div>
      )}

      {/* Header */}
      <header className="p-6 md:p-8 shrink-0 border-b bg-white relative z-20 shadow-sm flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight text-slate-900 mb-2">Student Activity Timeline</h1>
          <p className="text-slate-500 text-sm md:text-base max-w-2xl">A chronicle of achievements stretching back to {events.length ? format(events[0].startDate, "yyyy") : "2014"}. Click an event to expand details.</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center bg-slate-100 p-1 rounded-lg border border-slate-200">
            <span className="hidden md:inline text-[10px] font-bold text-slate-400 uppercase tracking-widest ml-2 mr-3">Group By</span>
            <div className="flex gap-1">
              {(['none', 'organisation', 'type'] as const).map((opt) => {
                const labels = { none: 'None', organisation: 'Org', type: 'Role Type' };
                return (
                  <button
                    key={opt}
                    onClick={() => setGrouping(opt)}
                    className={`px-3 py-1 text-xs font-semibold rounded-md transition-all cursor-pointer ${
                      grouping === opt 
                        ? 'bg-white text-slate-800 shadow-sm ring-1 ring-slate-900/5' 
                        : 'text-slate-500 hover:text-slate-700 hover:bg-black/5'
                    }`}
                  >
                    {labels[opt]}
                  </button>
                );
              })}
            </div>
          </div>
          <button 
            onClick={(e) => { e.stopPropagation(); setShowSettings(true); }}
            className="flex items-center gap-1 bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 hover:text-slate-900 p-2 rounded-lg shadow-sm transition-colors"
            title="Timeline Settings"
          >
            <Settings2 size={18} />
          </button>
        </div>
      </header>

      {/* Main horizontally scrolling area */}
      <main ref={scrollContainerRef} className="flex-1 overflow-x-auto overflow-y-auto relative w-full custom-scrollbar">
        <div className="relative mt-8 mb-32 ml-4 md:ml-32" style={{ width: timelineWidth, height: Math.max(maxLanes * laneHeight + 100, 400) }}>
          
          {/* Lane Group Labels */}
          <div className="absolute left-0 top-0 bottom-0 pointer-events-none z-10" style={{ transform: 'translateX(-100%)', width: '100px' }}>
             {laneGroups.map((g, idx) => (
                <div 
                  key={idx} 
                  className="absolute right-4 border-r-2 border-slate-300 pr-3 flex items-center justify-end"
                  style={{ top: g.startLane * laneHeight, height: g.laneCount * laneHeight }}
                >
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest -rotate-90 origin-right whitespace-nowrap opacity-60 mix-blend-multiply">
                    {g.label}
                  </span>
                </div>
             ))}
          </div>

          {/* Group Category Separators */}
          {grouping !== 'none' && laneGroups.map((g, idx) => {
             if (idx === laneGroups.length - 1) return null;
             return (
               <div 
                 key={`sep-${idx}`} 
                 className="absolute right-0 h-[3px] bg-slate-300/80 rounded-r-full z-10 pointer-events-none shadow-sm"
                 style={{ 
                   left: '-100px', 
                   top: (g.startLane + g.laneCount) * laneHeight - 1,
                 }}
               />
             );
          })}

          {/* Timeline Year Axis Lines */}
          {years.map((yItem) => (
             <div 
               key={yItem.year} 
               className="absolute top-0 bottom-0 border-l border-slate-200 border-dashed pointer-events-none mix-blend-multiply"
               style={{ left: yItem.left }}
             >
               <span className="absolute -top-6 -left-4 font-bold text-slate-400/80 text-xs bg-slate-50 px-1 rounded">{yItem.year}</span>
             </div>
          ))}

          {/* Horizontal Zebra Striping for Lanes (Subtle) */}
          <div className="absolute inset-0 pointer-events-none z-0">
            {Array.from({ length: maxLanes }).map((_, i) => (
              <div key={i} className={`w-full ${i % 2 === 0 ? 'bg-black/[0.015]' : 'bg-transparent'}`} style={{ height: laneHeight }}></div>
            ))}
          </div>

          {/* Events */}
          {events.map((ev) => {
            const orgColor = colors[ev.organisation] || DEFAULT_ORGANIZATION_COLOR;
            const isDecoration = ev.type === 'decoration';
            const isFunctionary = ev.type === 'functionary';
            const isExpanded = expandedId === ev.id;

            return (
              <div
                key={ev.id}
                onClick={(e) => { e.stopPropagation(); setExpandedId(isExpanded ? null : ev.id); }}
                className={`absolute transition-all duration-300 cursor-pointer ${isExpanded ? 'z-50' : 'z-10 hover:z-30 hover:brightness-110'}`}
                style={{
                  top: ev.topOffsetPixels + 4, // Center slightly in lane
                  left: ev.leftOffsetPixels,
                  width: ev.widthPixels, 
                  height: laneHeight - 12, // Maintain padding inside lane
                }}
              >
                {isDecoration ? (
                  <div className="relative group flex items-center h-full">
                    <div className="absolute left-1/2 top-1 bottom-[-1000px] w-px border-l border-dashed -z-10 opacity-30 select-none pointer-events-none" style={{ borderColor: orgColor }}></div>
                    <div 
                      className="h-8 w-8 relative z-10 rounded-full shadow-md border-2 flex items-center justify-center text-white transform transition-transform group-hover:scale-110" 
                      style={{ backgroundColor: orgColor, borderColor: 'white' }}
                      title={ev.name}
                    >
                      <Award size={14} />
                    </div>
                    <div className="absolute inset-0 bg-white rounded-full blur-sm opacity-40 -z-10" style={{ backgroundColor: orgColor }}></div>
                  </div>
                ) : (
                  <div 
                    className={`h-full w-full rounded shadow-sm overflow-hidden flex items-center px-2 border relative group`}
                    style={{ 
                       backgroundColor: isFunctionary ? orgColor : `${orgColor}1A`,
                       borderColor: isFunctionary ? 'transparent' : orgColor, 
                       color: isFunctionary ? 'white' : orgColor 
                    }}
                    title={ev.name}
                  >
                    <span className="text-[11px] font-semibold truncate select-none">{ev.name}</span>
                    {ev.subEvents.length > 1 && (
                       <span className="ml-auto text-[9px] font-bold opacity-75 shrink-0 bg-black/10 px-1 rounded">x{ev.subEvents.length}</span>
                    )}
                  </div>
                )}

                {/* Expanded Popover */}
                {isExpanded && (
                  <div 
                    className="absolute bg-white/95 backdrop-blur-xl border border-slate-200 shadow-2xl rounded-xl p-4 w-72 md:w-80 transition-opacity animate-in fade-in z-50 ring-1 ring-slate-900/5 cursor-auto"
                    style={{
                      top: 'calc(100% + 4px)',
                      left: '0px',
                    }}
                    onClick={(e) => e.stopPropagation()} 
                  >
                    <button 
                      onClick={closeExpanded} 
                      className="absolute top-3 right-3 text-slate-400 hover:text-slate-800 transition-colors bg-slate-100 rounded-full p-1 border hover:bg-slate-200"
                    >
                      <X size={14} />
                    </button>
                    
                    <div className="flex items-center gap-2 mb-3">
                      {isDecoration ? <Award size={16} style={{ color: orgColor }} /> : isFunctionary ? <Briefcase size={16} style={{ color: orgColor }} /> : <Users size={16} style={{ color: orgColor }} />}
                      <span className="text-[10px] uppercase font-bold tracking-widest px-2 py-0.5 rounded-full" style={{ color: orgColor, backgroundColor: `${orgColor}1A` }}>
                        {ev.organisation} • {ev.type}
                      </span>
                    </div>
                    
                    <h3 className="font-bold text-slate-900 leading-tight text-lg mb-1">{ev.name}</h3>
                    
                    <div className="mt-3 space-y-2">
                      {ev.subEvents.map((sub, idx) => (
                         <div key={idx} className="bg-slate-50 border border-slate-100 rounded p-2 text-sm text-slate-700">
                           <div className="font-semibold text-[11px] uppercase tracking-wide text-slate-500 mb-1">
                             {isDecoration ? format(sub.startDate, 'MMMM do, yyyy') : `${format(sub.startDate, 'MMM yyyy')} — ${format(sub.endDate, 'MMM yyyy')}`}
                           </div>
                           {sub.description && <p className="leading-snug text-xs mt-1">{sub.description}</p>}
                         </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </main>
    </div>
  );
}
