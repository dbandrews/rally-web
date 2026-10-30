"""Data roots for the verified format parsers copied from research/tools (rally-web asset pipeline).

The parsers in this directory are copies of research/tools/fmt_*.py (independently verified, see
research/formats/*.md "## Verification"). The ONLY change made to each copy is that its data-root
constants come from here instead of pointing at research/full:

  FULL       the extracted-archive cache, same layout as research/full:
             <repo>/.cache/original/<archive>/...   (tools/assets/lib/archive.py fills it)
             override with the environment variable RALLY_ORIG_CACHE
  REPO       the repository root (relative paths in dumps are relative to it)
  ART_ROOT   <repo>/artifacts/re  (proof images written by the parsers' CLI subcommands; gitignored)
  DUMPS      <repo>/.cache/dumps  (where the parsers' CLI "dump" commands write their JSON; gitignored)
  DATA       tools/assets/lib/formats/data (shipped copies of research data the parsers read, e.g.
             environment_cmds.json = the console command table)
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..', '..'))
FULL = os.path.abspath(os.environ.get('RALLY_ORIG_CACHE') or os.path.join(REPO, '.cache', 'original'))
ART_ROOT = os.path.join(REPO, 'artifacts', 're')
DUMPS = os.path.join(REPO, '.cache', 'dumps')
DATA = os.path.join(HERE, 'data')
