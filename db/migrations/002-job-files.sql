-- Private, versioned source/proof files. Existing artwork and proof rows survive.
CREATE TABLE IF NOT EXISTS print_shop.job_files (
  id text PRIMARY KEY,
  job_id integer NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  version bigint GENERATED ALWAYS AS IDENTITY,
  kind text NOT NULL CHECK (kind IN ('artwork', 'proof')),
  filename text NOT NULL,
  media_type text NOT NULL CHECK (media_type IN ('application/pdf', 'image/png', 'image/jpeg')),
  size integer NOT NULL CHECK (size > 0 AND size <= 10485760),
  bytes bytea NOT NULL,
  uploaded_at timestamptz NOT NULL,
  artwork_id text,
  UNIQUE (id, job_id),
  CHECK (octet_length(bytes) = size),
  CHECK ((kind = 'proof') = (artwork_id IS NOT NULL)),
  FOREIGN KEY (artwork_id, job_id) REFERENCES print_shop.job_files(id, job_id)
);
CREATE INDEX IF NOT EXISTS job_files_job_version_idx ON print_shop.job_files(job_id, version);

ALTER TABLE public.proofs ADD COLUMN IF NOT EXISTS file_id text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.proofs'::regclass AND conname='proofs_file_job_fk') THEN
    ALTER TABLE public.proofs ADD CONSTRAINT proofs_file_job_fk
      FOREIGN KEY (file_id, job_id) REFERENCES print_shop.job_files(id, job_id);
  END IF;
END $$;

INSERT INTO print_shop.schema_migrations(version) VALUES (2) ON CONFLICT DO NOTHING;
