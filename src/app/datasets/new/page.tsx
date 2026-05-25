import Link from "next/link";

export default function NewDatasetPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16 font-mono text-sm space-y-8">
      <header>
        <Link href="/" className="text-xs text-gray-500 dark:text-gray-400 hover:underline">
          ← all datasets
        </Link>
        <h1 className="text-xl font-bold mt-3">Add dataset</h1>
      </header>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Link
          href="/datasets/new/ingest"
          className="block border border-gray-200 dark:border-gray-800 rounded p-5 hover:bg-gray-50 dark:hover:bg-gray-900/50 space-y-2"
        >
          <div className="font-semibold text-sm">Ingest from URL</div>
          <div className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
            Point at a Parquet or CSV file. We load it into MotherDuck and ask
            Claude to write a Malloy semantic model.
          </div>
        </Link>

        <Link
          href="/datasets/new/github"
          className="block border border-gray-200 dark:border-gray-800 rounded p-5 hover:bg-gray-50 dark:hover:bg-gray-900/50 space-y-2"
        >
          <div className="font-semibold text-sm">Add Malloy model from GitHub</div>
          <div className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
            Point at a GitHub repo with an <code>index.malloy</code> at its root.
            Imports are resolved from the same repo and branch.
          </div>
        </Link>
      </div>
    </main>
  );
}
