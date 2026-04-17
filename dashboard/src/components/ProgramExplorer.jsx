import { useState } from "react";
import { PROGRAMS } from "../data/programs.js";

function ProgramCard({ programKey, isActive, onClick }) {
  const program = PROGRAMS[programKey];
  const Icon = program.icon;
  return (
    <button
      onClick={onClick}
      className={`w-full text-left p-4 rounded-xl border transition-all ${
        isActive
          ? "bg-white/10 border-white/20"
          : "bg-white/5 border-white/5 hover:bg-white/10"
      }`}
    >
      <div className="flex items-center gap-3">
        <div className={`p-2 rounded-lg bg-gradient-to-br ${program.color}`}>
          <Icon className="w-5 h-5 text-white" />
        </div>
        <div>
          <div className="font-semibold">{program.name}</div>
          <div className="text-xs text-gray-400">{program.instructions.length} instructions</div>
        </div>
      </div>
    </button>
  );
}

function ProgramDetail({ programKey }) {
  const program = PROGRAMS[programKey];
  const Icon = program.icon;
  return (
    <div>
      <div className="flex items-start gap-4 mb-4">
        <div className={`p-3 rounded-xl bg-gradient-to-br ${program.color}`}>
          <Icon className="w-6 h-6 text-white" />
        </div>
        <div className="flex-1">
          <h2 className="text-xl font-bold">{program.name}</h2>
          <p className="text-sm text-gray-400 mt-1">{program.description}</p>
          <code className="text-xs font-mono text-cyan-300 mt-2 inline-block break-all">
            {program.id}
          </code>
        </div>
      </div>

      <div className="mb-4">
        <h3 className="text-sm font-semibold text-gray-300 mb-2">Features</h3>
        <ul className="text-sm space-y-1">
          {program.features.map((f, i) => (
            <li key={i} className="text-gray-400 flex items-start gap-2">
              <span className="text-emerald-400">•</span>
              {f}
            </li>
          ))}
        </ul>
      </div>

      <div className="mb-4">
        <h3 className="text-sm font-semibold text-gray-300 mb-2">Instructions</h3>
        <div className="space-y-1">
          {program.instructions.map((ins, i) => (
            <div key={i} className="flex items-center gap-3 text-sm">
              <code className="text-cyan-300 font-mono text-xs w-56 flex-shrink-0">
                {ins.name}
              </code>
              <span className="text-gray-400 text-xs">{ins.desc}</span>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-gray-300 mb-2">Accounts</h3>
        {program.accounts.map((acc, i) => (
          <div key={i} className="flex items-center gap-3 text-sm">
            <code className="text-cyan-300 font-mono text-xs w-32 flex-shrink-0">{acc.name}</code>
            <span className="text-xs text-gray-500">{acc.size}</span>
            <span className="text-gray-400 text-xs">— {acc.desc}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function ProgramExplorer() {
  const [activeProgram, setActiveProgram] = useState("vault");
  return (
    <div className="grid grid-cols-12 gap-6">
      <div className="col-span-4 space-y-2">
        {Object.keys(PROGRAMS).map((key) => (
          <ProgramCard
            key={key}
            programKey={key}
            isActive={activeProgram === key}
            onClick={() => setActiveProgram(key)}
          />
        ))}
      </div>
      <div className="col-span-8 bg-white/5 rounded-xl border border-white/10 p-6">
        <ProgramDetail programKey={activeProgram} />
      </div>
    </div>
  );
}
