#!/usr/bin/env python3
"""
fmt_meme.py -- "MemeFile 2.0" (dice::meme) UI object graphs of the original rally game: a complete parser.

The front end and the HUD of the original are serialized object graphs written by the editor 'MemeEdit'.
All 698 meme files live in the Menu archive (Menu/menu/** 369 files, Menu/multimenu/** 329 files; no other
archive holds the magic).  This module parses every one of them with every byte accounted for and returns a
JSON-serialisable object graph.  Spec: research/formats/meme.md.

File layout [E FUN_005d8140 -> FUN_005f0aa0 / FUN_005f0b20 -> FUN_005d8260, ClassIStream vtable 0x8196c8]
    u8 len + "MemeFile 2.0"                     header string, checked against 0x850dfc
    { u8 len + chars }* , u8 0                  string table (class names AND object names), 1-based
    u16 rootClass                               root object: class-name index, no size record
    <root body>                                 = the class's fields (below), to end of file
Object reference ("pointer", FUN_005d7d30)
    u32 size   (bytes from the start of this u32 to the end of the object)
    u16 objectName   (string-table index, 0 = "")
    u16 className    (string-table index, 0 = "")
    <body>     class == 0: no body; size == 8.  name != "" -> reference to the meme file / registered
               object of that name ({'$ref': name}); name == "" -> null.
Primitive encodings (base istream FUN_005f03b0.., all little-endian)
    f32, i32 (int / enum), bool (u8 != 0), i8, str (u32 n + n bytes), wstr (u32 n + 2n bytes UTF-16LE),
    tex / font / sound (u8 n + n chars: a resource name resolved by the System, vt 0x8c / 0x80 / 0xa0),
    list (object references until a null reference; FUN_005f3b40), NavigateTree (FUN_005f3380, below).
Every class's field order and types come from the exe's own deserializer (vt[0x34] -> vt[0x30]) run in
unicorn (research/tools/meme_emu.py); the table below is generated from that run.

Usage:
    .venv/bin/python -I tools/assets/lib/formats/fmt_meme.py dump [--out research/formats/meme_dump.json]
    .venv/bin/python -I tools/assets/lib/formats/fmt_meme.py show Menu/menu/Main/MainFrame
Library:
    import fmt_meme; doc = fmt_meme.parse_file(path)   # {'strings': [...], 'root': {...}}
Object dicts: {'$class': 'NameNode', '$name': '', '$at': <file offset of the size field>, <label>: value, ...}
plus '$legacy' (older layout, see LEGACY) and '$unread' (hex of bytes the exe skips).
"""
from __future__ import annotations

import json
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _paths import FULL, REPO  # noqa: E402

MAGIC = b'MemeFile 2.0'

# class -> (base class, fields).  Field kinds: ptr f32 i32 enum bool i8 str wstr tex font sound list;
# ('v==1',): the rest is read only when the preceding 'Version <do not edit>' == 1 (else the exe's read fails
# and the caller skips to the end of the object); ('v>=2',): the next field only when version >= 2.
# Labels are the exe's own field names (the strings it passes to the stream).  A label repeated inside one
# class (exe copy/paste) gets ' #2', ' #3' in the output.
CLASSES = {
    'Action': ('Object', ()),
    'ActionFunction': ('Function', (('ptr', 'Action'),)),
    'ActionListAction': ('Action', (('list', 'Action list'),)),
    'ActionNode': ('Node', (('ptr', 'Next node'), ('ptr', 'Action'),)),
    'AddData': ('OperatorData', (('ptr', 'Data 1'), ('ptr', 'Data 2'),)),
    'AlphaFadeEffect': ('Effect', ()),
    'AndData': ('LogicalData', (('ptr', 'Data 1'), ('ptr', 'Data 2'),)),
    'AnyKeyEvent': ('Event', (('i8', 'Input index (0 == all indexes)'), ('enum', 'Event type'),)),
    'BinkNode': ('Node', (('ptr', 'Next node'), ('ptr', 'Bink filename (without extension)'), ('f32', 'Fade time'),)),
    'BlendFuncEffect': ('Effect', (('enum', 'Source blend func'), ('enum', 'Destination blend func'),)),
    'BoolData': ('Data', (('bool', 'Value <do not edit>'),)),
    'ButtonEvent': ('TypeEvent', (('i8', 'Input index (0 == all indexes)'), ('enum', 'Event type'), ('enum', 'Button type'),)),
    'BzztEffect': ('Effect', (('i32', 'Cut count'), ('f32', 'Bzzt width'),)),
    'CallConsoleAction': ('Action', (('ptr', 'Console string'),)),
    'CallFunctionAction': ('Action', (('ptr', 'Function'),)),
    'CallFunctionVariableAction': ('CallFunctionAction', (('ptr', 'Function'), ('ptr', 'Result data'),)),
    'CareerEventStatusNode': ('Node', (('ptr', 'Next node'), ('ptr', 'Event name'), ('ptr', 'Style'), ('ptr', 'Total String'), ('ptr', 'Race String'), ('ptr', 'Position String'), ('ptr', 'Points String'), ('ptr', 'Position Title String'), ('ptr', 'Time Title String'), ('ptr', 'Score Title String'), ('ptr', 'Bonus String'), ('ptr', 'Status String'),)),
    'CareerPointsBarNode': ('Node', (('ptr', 'Next node'), ('ptr', 'Style'), ('ptr', 'Career Total String'), ('ptr', 'Pro String'), ('ptr', 'Expert String'), ('ptr', 'Classic String'), ('ptr', 'Unlimited String'), ('ptr', 'Points String'),)),
    'CarSettingsListBoxData': ('ListBoxData', (('ptr', 'Player index'),)),
    'CenterAlignedScaleYStyle': ('ScaleYStyle', (('font', 'Font handle'),)),
    'CenterAlignedSizeStyle': ('SizeStyleExtra', (('font', 'Font handle'), ('f32', 'Size constant'),)),
    'CenterAlignedStyle': ('Style', (('font', 'Font handle'),)),
    'CheatEvent': ('Event', (('i8', 'Input index (0 == all indexes)'), ('ptr', 'String'),)),
    'CheckpointMeterNode': ('Node', (('ptr', 'Next node'), ('ptr', 'Current position'), ('ptr', 'Total Distance'), ('ptr', 'Checkpoints'), ('ptr', 'Current lap'), ('ptr', 'Lap count'), ('ptr', 'Player checkpoint times'),)),
    'CheckpointStandingsNode': ('Node', (('ptr', 'Next node'), ('i32', 'Player index'), ('ptr', 'Player name'), ('ptr', 'Player current position'), ('ptr', 'Player checkpoint times'), ('ptr', 'Race checkpoints'), ('font', 'Font'), ('f32', 'Visible time'), ('f32', 'Show delta time'), ('f32', 'Hide delta time'), ('tex', 'Arrow picture'), ('tex', 'Circle picture'),)),
    'ClipEffect': ('Effect', (('f32', 'X'), ('f32', 'Y'), ('f32', 'Width'), ('f32', 'Height'),)),
    'ClipNode': ('Node', (('ptr', 'Next node'),)),
    'ColorEffect': ('Effect', (('f32', 'Red'), ('f32', 'Green'), ('f32', 'Blue'), ('f32', 'Alpha'),)),
    'ConcatenateListData': ('Data', (('list', 'Data list'),)),
    'ControllerInputData': ('Data', (('ptr', 'Input name'), ('enum', 'Input type'),)),
    'ControllerInputListBoxData': ('ListBoxData', (('list', 'Input list'), ('ptr', 'Reset string'), ('ptr', 'Reset action'), ('ptr', 'Reset focus action'), ('ptr', 'Normal focus action'),)),
    'ConverterData': ('Data', (('ptr', 'From data'), ('ptr', 'To data'), ('ptr', 'Source data'),)),
    'CountdownNode': ('Node', (('ptr', 'Next node'), ('tex', 'Go'), ('tex', 'First'), ('tex', 'Second'), ('tex', 'Third'), ('tex', 'Fourth'), ('ptr', 'Time'),)),
    'CullActionNode': ('ActionNode', (('ptr', 'Next node'), ('ptr', 'Action'), ('i8', 'Event type (OBS; DO NOT USE!, OLD CLASS)'), ('i32', 'Event data(OBS; DO NOT USE!, OLD CLASS)'),)),
    'CullEventActionNode': ('ActionNode', (('ptr', 'Next node'), ('ptr', 'Action'), ('ptr', 'Event'),)),
    'CullEventTimeoutActionNode': ('CullEventActionNode', (('ptr', 'Next node'), ('ptr', 'Action'), ('ptr', 'Event'), ('f32', 'Timeout time'),)),
    'CullNode': ('Node', (('ptr', 'Next node'), ('ptr', 'Data'), ('f32', 'In time'), ('f32', 'Out time'),)),
    'CullVariableActionNode': ('ActionNode', (('ptr', 'Next node'), ('ptr', 'Action'), ('ptr', 'Variable'),)),
    'CullVariableAndEventActionNode': ('ActionNode', (('ptr', 'Next node'), ('ptr', 'Action'), ('ptr', 'Variable'), ('ptr', 'Event'),)),
    'Data': ('Object', ()),
    'DataListData': ('Data', (('list', 'Data list'),)),
    'DisableNode': ('Node', (('ptr', 'Next node'), ('ptr', 'Disable data'),)),
    'DivData': ('OperatorData', (('ptr', 'Data 1'), ('ptr', 'Data 2'),)),
    'DragWindowNode': ('WindowNode', (('ptr', 'Next node'), ('f32', 'X'), ('f32', 'Y'), ('f32', 'Width'), ('f32', 'Height'), ('ptr', 'Transformed node'),)),
    'DynamicIndexPointer': ('Pointer', ()),
    'EditNode': ('Node', (('ptr', 'Next node'), ('font', 'Font'), ('ptr', 'String'), ('i32', 'Max characters(-1 = no limit)'),)),
    'Effect': ('Object', ()),
    'EffectNode': ('Node', (('ptr', 'Next node'), ('ptr', 'Effect'),)),
    'EqualData': ('LogicalData', (('ptr', 'Data 1'), ('ptr', 'Data 2'),)),
    'Event': ('Object', (('i8', 'Input index (0 == all indexes)'),)),
    'EventTrackAction': ('Action', (('ptr', 'Event name'), ('ptr', 'Track name'),)),
    'ExclusiveOrData': ('LogicalData', (('ptr', 'Data 1'), ('ptr', 'Data 2'),)),
    'ExtendedButtonEvent': ('TypeEvent', (('i8', 'Input index (0 == all indexes)'), ('enum', 'Event type'), ('enum', 'Button type'), ('i32', 'Repeat count'),)),
    'ExtendedFocusToPressedEffectNode': ('FocusToPressedEffectNode', (('ptr', 'Next node'), ('ptr', 'Effect'), ('f32', 'Min value'), ('f32', 'Max value'),)),
    'ExtendedNormalToFocusEffectNode': ('NormalToFocusEffectNode', (('ptr', 'Next node'), ('ptr', 'Effect'), ('f32', 'Min value'), ('f32', 'Max value'),)),
    'ExtendedRememberingTabstopManagerNode': ('TabstopManagerNode', (('ptr', 'Next node'), ('ptr', 'Index'),)),
    'FloatData': ('Data', (('f32', 'Value <do not edit>'),)),
    'FloatRefData': ('Data', ()),
    'FocusEffectNode': ('EffectNode', (('ptr', 'Next node'), ('ptr', 'Effect'),)),
    'FocusLockedData': ('Data', ()),
    'FocusNode': ('Node', (('ptr', 'Next node'), ('ptr', 'Focus X'), ('ptr', 'Focus Y'),)),
    'FocusToPressedEffectNode': ('EffectNode', (('ptr', 'Next node'), ('ptr', 'Effect'),)),
    'Function': ('Object', ()),
    'GearNode': ('Node', (('ptr', 'Next node'), ('tex', 'Reverse gear'), ('tex', 'Gear one'), ('tex', 'Gear two'), ('tex', 'Gear three'), ('tex', 'Gear four'), ('tex', 'Gear five'), ('tex', 'Gear six'), ('ptr', 'Gear'),)),
    'GenericModelNode': ('Node', (('ptr', 'Next node'), ('ptr', 'Model'), ('ptr', 'Translation X'), ('ptr', 'Translation X'), ('ptr', 'Translation X'), ('ptr', 'Rotation X'), ('ptr', 'Rotation Y'), ('ptr', 'Rotation Z'), ('f32', 'Load wait time'),)),
    'GhostListBoxData': ('ListBoxData', (('ptr', 'Ghost name'), ('ptr', 'Load function'),)),
    'GhostNode': ('Node', (('ptr', 'Next node'), ('ptr', 'Track'), ('ptr', 'From car list'), ('ptr', 'To car list'), ('ptr', 'Style'), ('f32', 'Car delta X'), ('f32', 'Time delta X'), ('f32', 'Date delta X'), ('ptr', 'Date format'), ('ptr', 'Track has ghosts'), ('ptr', 'Select action'),)),
    'HideDisableEffect': ('Effect', ()),
    'IfElseEventActionNode': ('ActionNode', (('ptr', 'Next node'), ('ptr', 'Action'), ('ptr', 'Variable'), ('ptr', 'Else Action'), ('ptr', 'Event'),)),
    'IndexCountData': ('Data', (('ptr', 'Data'),)),
    'IndexDataData': ('Data', (('ptr', 'Data'), ('ptr', 'Index'),)),
    'IngameListExNode': ('IngameListNode', (('ptr', 'Next node'), ('i32', 'Version <do not edit>'), ('ptr', 'Style'), ('list', 'Data list'), ('sound', 'Step sound'), ('sound', 'Select sound'), ('f32', 'Option list y'), ('v>=2',), ('f32', 'Row height <0 = auto>'),)),
    'IngameListNode': ('Node', (('ptr', 'Next node'), ('font', 'Font'), ('list', 'Data list'), ('sound', 'Step sound'), ('sound', 'Select sound'), ('f32', 'Option list y'),)),
    'IntData': ('Data', (('i32', 'Value <do not edit>'),)),
    'IStream': (None, ()),
    'LanguageListBoxData': ('ListBoxData', ()),
    'LastInputIndexAction': ('Action', (('ptr', 'Last input index'),)),
    'LastPadIndexAction': ('Action', (('ptr', 'Last pad index'),)),
    'LessData': ('LogicalData', (('ptr', 'Data 1'), ('ptr', 'Data 2'),)),
    'LessEqualData': ('LogicalData', (('ptr', 'Data 1'), ('ptr', 'Data 2'),)),
    'ListBoxData': ('Data', ()),
    'LocaleStringData': ('StringData', (('i32', 'Int'),)),
    'LockPadIndexAction': ('Action', (('ptr', 'Lock pad index'),)),
    'LockPointerAction': ('Action', (('ptr', 'Input index data'),)),
    'LogicalData': ('Data', (('ptr', 'Data 1'), ('ptr', 'Data 2'),)),
    'MeterNeedleNode': ('Node', (('ptr', 'Next node'), ('f32', 'Delta point width'), ('f32', 'Delta base width'), ('f32', 'Delta base offset'), ('f32', 'Red'), ('f32', 'Green'), ('f32', 'Blue'), ('f32', 'Alpha'), ('f32', 'Shadow scale'), ('f32', 'Red'), ('f32', 'Green'), ('f32', 'Blue'), ('f32', 'Alpha'),)),
    'ModelNode': ('Node', (('ptr', 'Next node'), ('ptr', 'Model'), ('ptr', 'Translation X'), ('ptr', 'Translation X'), ('ptr', 'Translation X'), ('ptr', 'Rotation X'), ('ptr', 'Rotation Y'), ('ptr', 'Rotation Z'), ('f32', 'Load wait time'),)),
    'ModifyVariableAction': ('Action', (('ptr', 'Variable'), ('f32', 'Modify value'), ('f32', 'Limit value'),)),
    'MouseCullNode': ('Node', (('ptr', 'Next node'), ('bool', 'Use keyboard'),)),
    'MoveClipEffect': ('ClipEffect', (('f32', 'X'), ('f32', 'Y'), ('f32', 'Width'), ('f32', 'Height'), ('f32', 'Move length'), ('f32', 'Move direction'),)),
    'MoveEffect': ('Effect', (('ptr', 'Move length'), ('ptr', 'Move direction'),)),
    'MulData': ('OperatorData', (('ptr', 'Data 1'), ('ptr', 'Data 2'),)),
    'MultiIngameListNode': ('Node', (('ptr', 'Next node'), ('ptr', 'Ingame list node'), ('ptr', 'Ingame list node'), ('ptr', 'Ingame list node'), ('ptr', 'Ingame list node'), ('f32', 'Node spacing'), ('ptr', 'Player car name (array)'), ('ptr', 'Player name (array)'),)),
    'MultiplyColorEffect': ('ColorEffect', (('f32', 'Red'), ('f32', 'Green'), ('f32', 'Blue'), ('f32', 'Alpha'),)),
    'MultiplyVertexColorEffect': ('VertexColorEffect', (('f32', 'Top left red'), ('f32', 'Top left green'), ('f32', 'Top left blue'), ('f32', 'Top left alpha'), ('f32', 'Top right red'), ('f32', 'Top right green'), ('f32', 'Top right blue'), ('f32', 'Top right alpha'), ('f32', 'Bottom right red'), ('f32', 'Bottom right green'), ('f32', 'Bottom right blue'), ('f32', 'Bottom right alpha'), ('f32', 'Bottom left red'), ('f32', 'Bottom left green'), ('f32', 'Bottom left blue'), ('f32', 'Bottom left alpha'),)),
    'NameNode': ('Node', (('ptr', 'Next node'),)),
    'NavigateAction': ('Action', (('ptr', 'Action tree'),)),
    'NavigateChildAction': ('NavigateAction', (('ptr', 'Action tree'),)),
    'NavigateChildAndRunAction': ('NavigateAction', (('ptr', 'Action tree'),)),
    'NavigateFirstSiblingAction': ('NavigateAction', (('ptr', 'Action tree'),)),
    'NavigateLastSiblingAction': ('NavigateAction', (('ptr', 'Action tree'),)),
    'NavigateNextSiblingAction': ('NavigateAction', (('ptr', 'Action tree'),)),
    'NavigateParentAction': ('NavigateAction', (('ptr', 'Action tree'),)),
    'NavigateParentAndRunAction': ('NavigateAction', (('ptr', 'Action tree'),)),
    'NavigatePreviousSiblingAction': ('NavigateAction', (('ptr', 'Action tree'),)),
    'NavigateRunAction': ('NavigateAction', (('ptr', 'Action tree'),)),
    'NavigateRunAndChildAction': ('NavigateAction', (('ptr', 'Action tree'),)),
    'NavigateSiblingIndexAction': ('NavigateAction', (('ptr', 'Action tree'), ('i32', 'Index'),)),
    'NavigateTree': ('Tree', (('bool', 'Bool'),)),
    'NavigateViewNode': ('Node', (('ptr', 'Next node'), ('ptr', 'Navigate tree'), ('font', 'Font'),)),
    'Node': ('Object', (('ptr', 'Next node'),)),
    'NodeListNode': ('Node', (('ptr', 'Next node'), ('list', 'Node list'), ('ptr', 'Index'), ('f32', 'Item height'), ('sound', 'Select sound'), ('sound', 'Up down sound'),)),
    'NoOpAction': ('Action', ()),
    'NormalToFocusEffectNode': ('EffectNode', (('ptr', 'Next node'), ('ptr', 'Effect'),)),
    'NotData': ('LogicalData', (('ptr', 'Data'),)),
    'NotEqualData': ('LogicalData', (('ptr', 'Data 1'), ('ptr', 'Data 2'),)),
    'NotFocusEffectNode': ('EffectNode', (('ptr', 'Next node'), ('ptr', 'Effect'),)),
    'Object': (None, ()),
    'OperatorData': ('Data', (('ptr', 'Data 1'), ('ptr', 'Data 2'),)),
    'OptionActionData': ('Data', (('ptr', 'String'), ('ptr', 'Action'), ('ptr', 'Disable data'), ('ptr', 'Focus action'),)),
    'OptionListData': ('Data', (('ptr', 'String'), ('list', 'Data list'), ('ptr', 'Focus index'), ('ptr', 'Disable data'), ('ptr', 'Focus action'), ('f32', 'Left Button X'), ('f32', 'Left Button Y'), ('f32', 'Right Button X'), ('f32', 'Right Button Y'), ('f32', 'Button scale X'), ('f32', 'Button scale Y'), ('ptr', 'Edit mode action'), ('ptr', 'Normal mode action'),)),
    'OptionListExData': ('OptionListData', (('i32', 'Version <do not edit>'), ('v==1',), ('ptr', 'String'), ('list', 'Data list'), ('ptr', 'Focus index'), ('ptr', 'Disable data'), ('ptr', 'Focus action'), ('f32', 'Button width'), ('f32', 'Button height'), ('f32', 'Button spacing'),)),
    'OptionToggleData': ('OptionActionData', (('ptr', 'String'), ('ptr', 'Action'), ('ptr', 'Disable data'), ('ptr', 'Focus action'), ('ptr', 'Action 2'), ('ptr', 'String 1'), ('ptr', 'String 2'),)),
    'OrData': ('LogicalData', (('ptr', 'Data 1'), ('ptr', 'Data 2'),)),
    'OStream': (None, ()),
    'PaceNoteNode': ('Node', (('ptr', 'Next node'), ('ptr', 'Current pace note 1'), ('ptr', 'Current pace note 2'), ('ptr', 'Current pace note 3'), ('tex', 'Easy arrow'), ('f32', 'Red'), ('f32', 'Green'), ('f32', 'Blue'), ('f32', 'Alpha'), ('tex', 'Medium arrow'), ('f32', 'Red'), ('f32', 'Green'), ('f32', 'Blue'), ('f32', 'Alpha'), ('tex', 'Hard arrow'), ('f32', 'Red'), ('f32', 'Green'), ('f32', 'Blue'), ('f32', 'Alpha'), ('tex', 'Hairpin arrow'), ('f32', 'Red'), ('f32', 'Green'), ('f32', 'Blue'), ('f32', 'Alpha'), ('tex', 'Tight hairpin arrow'), ('f32', 'Red'), ('f32', 'Green'), ('f32', 'Blue'), ('f32', 'Alpha'), ('tex', 'Square arrow'), ('f32', 'Red'), ('f32', 'Green'), ('f32', 'Blue'), ('f32', 'Alpha'), ('tex', 'Narrows'), ('f32', 'Red'), ('f32', 'Green'), ('f32', 'Blue'), ('f32', 'Alpha'), ('tex', 'Over crest'), ('f32', 'Red'), ('f32', 'Green'), ('f32', 'Blue'), ('f32', 'Alpha'), ('tex', 'Over bridge'), ('f32', 'Red'), ('f32', 'Green'), ('f32', 'Blue'), ('f32', 'Alpha'), ('tex', 'Caution'), ('f32', 'Red'), ('f32', 'Green'), ('f32', 'Blue'), ('f32', 'Alpha'), ('tex', 'Background picture'), ('f32', 'Visible time'), ('f32', 'Visible time'), ('f32', 'Visible time'),)),
    'PathNode': ('NameNode', (('ptr', 'Next node'),)),
    'PictureNode': ('Node', (('ptr', 'Next node'), ('tex', 'Picture'),)),
    'PlayerCountData': ('Data', (('ptr', 'Player name (array)'),)),
    'PlayerInputIndexData': ('Data', ()),
    'PlayerPositionData': ('Data', (('ptr', 'Player distance (array)'), ('ptr', 'Player name (array)'), ('i32', 'Player index'),)),
    'PlaylistListBoxData': ('ListBoxData', (('ptr', 'Source list'), ('ptr', 'Destination list'),)),
    'Pointer': ('Object', ()),
    'PopPathAction': ('SetPathAction', (('ptr', 'Stack path node'), ('f32', 'In time'), ('f32', 'Out time'), ('f32', 'In wait time'), ('f32', 'Out wait time'), ('bool', 'Paint outnode over innode'),)),
    'PostButtonEventAction': ('Action', (('enum', 'Event type'), ('enum', 'Button type'),)),
    'ProfileInfoData': ('Data', (('ptr', 'Difficult string'),)),
    'ProfileListBoxData': ('ListBoxData', (('ptr', 'Create new action'), ('ptr', 'Create new string'), ('ptr', 'Profile name'), ('ptr', 'Create new in focus'), ('ptr', 'Default action'),)),
    'PushPathAction': ('SetPathAction', (('ptr', 'Stack path node'), ('ptr', 'Destination node'), ('f32', 'In time'), ('f32', 'Out time'), ('f32', 'In wait time'), ('f32', 'Out wait time'), ('bool', 'Paint outnode over innode'),)),
    'RallyBoxNode': ('Node', (('ptr', 'Next node'), ('sound', 'Step sound'), ('bool', 'Use tab'), ('i32', 'Use cursors'), ('ptr', 'Disable list'), ('ptr', 'Box node'),)),
    'RallyButtonListConfirmNode': ('Node', (('ptr', 'Next node'), ('f32', 'Button width'), ('f32', 'Button height'), ('f32', 'Delta button spacing'), ('f32', 'Scale factor'), ('f32', 'Scroll speed'), ('f32', 'Delta break distance'), ('f32', 'Zoom speed'), ('f32', 'Zoom size'), ('i32', 'Loop'), ('ptr', 'Scroll position out'), ('list', 'Button list'), ('sound', 'Select sound'), ('sound', 'Step sound'), ('sound', 'Cannot select sound'), ('ptr', 'Show disabled buttons'), ('ptr', 'Focus index'),)),
    'RallyButtonListExNode': ('Node', (('ptr', 'Next node'), ('f32', 'Button width'), ('f32', 'Button height'), ('f32', 'Delta button spacing'), ('f32', 'Scale factor'), ('f32', 'Scroll speed'), ('f32', 'Delta break distance'), ('f32', 'Zoom speed'), ('f32', 'Zoom size'), ('i32', 'Loop'), ('ptr', 'Scroll position out'), ('list', 'Button list'), ('sound', 'Select sound'), ('sound', 'Step sound'), ('sound', 'Cannot select sound'), ('ptr', 'Show disabled buttons'), ('ptr', 'Focus index'),)),
    'RallyButtonListNode': ('Node', (('ptr', 'Next node'), ('f32', 'Button width'), ('f32', 'Button height'), ('f32', 'Delta button spacing'), ('f32', 'Scale factor'), ('f32', 'Scroll speed'), ('f32', 'Delta break distance'), ('f32', 'Zoom speed'), ('f32', 'Zoom size'), ('i32', 'Loop'), ('ptr', 'Scroll position out'), ('list', 'Button list'), ('sound', 'Select sound'), ('sound', 'Step sound'), ('sound', 'Cannot select sound'), ('ptr', 'Show disabled buttons'), ('ptr', 'Focus action'), ('ptr', 'Focus index'), ('bool', 'Disable highlight'), ('f32', 'Left Button X'), ('f32', 'Left Button Y'), ('f32', 'Right Button X'), ('f32', 'Right Button Y'), ('f32', 'Button scale X'), ('f32', 'Button scale Y'),)),
    'RallyButtonNode': ('Node', (('ptr', 'Next node'), ('ptr', 'Title data'), ('ptr', 'Title style'), ('ptr', 'Select action'), ('ptr', 'Focus action'), ('ptr', 'Disable data'),)),
    'RallyCarButtonNode': ('RallyButtonNode', (('ptr', 'Next node'), ('ptr', 'Title data'), ('ptr', 'Title style'), ('ptr', 'Select action'), ('ptr', 'Focus action'), ('ptr', 'Disable data'), ('ptr', 'Title data 2 (NOT USED)'), ('ptr', 'Car info'), ('ptr', 'Car info 2 (NOT USED)'), ('ptr', 'Info style'), ('tex', 'Brand picture'),)),
    'RallyChallengesButtonNode': ('RallyButtonNode', (('ptr', 'Next node'), ('ptr', 'Title data'), ('ptr', 'Title style'), ('ptr', 'Select action'), ('ptr', 'Focus action'), ('ptr', 'Disable data'),)),
    'RallyCheckBox': ('Node', (('ptr', 'Next node'), ('ptr', 'Monitor'), ('ptr', 'Action'), ('tex', 'Check image'), ('sound', 'Change sound'),)),
    'RallyConfirmationButtonNode': ('RallyButtonNode', (('ptr', 'Next node'), ('ptr', 'Title data'), ('ptr', 'Title style'), ('ptr', 'Select action'), ('ptr', 'Focus action'), ('ptr', 'Disable data'),)),
    'RallyEditData': ('Data', ()),
    'RallyEditNode': ('Node', (('ptr', 'Next node'), ('font', 'Font'), ('ptr', 'String'), ('i32', 'Max characters(-1 = no limit)'), ('ptr', 'Select action'), ('ptr', 'Editbox data'), ('bool', 'Focus'),)),
    'RallyEventButtonNode': ('RallyButtonNode', (('ptr', 'Next node'), ('ptr', 'Title data'), ('ptr', 'Title style'), ('ptr', 'Select action'), ('ptr', 'Focus action'), ('ptr', 'Disable data'), ('ptr', 'Title 2'), ('tex', 'Picture handle'), ('tex', 'Disable picture handle'), ('tex', 'Cup handle'),)),
    'RallyGrid': ('Node', (('ptr', 'Next node'), ('f32', 'Grid size'), ('f32', 'Grid line thickness'),)),
    'RallyIAButtonNode': ('RallyButtonNode', (('ptr', 'Next node'), ('ptr', 'Title data'), ('ptr', 'Title style'), ('ptr', 'Select action'), ('ptr', 'Focus action'), ('ptr', 'Disable data'), ('ptr', 'Track title'), ('ptr', 'Record style'), ('ptr', 'Record text'), ('ptr', 'Record data'), ('tex', 'Track picture'), ('tex', 'Game type picture'),)),
    'RallyListBoxExNode': ('Node', (('ptr', 'Next node'), ('i32', 'Version <do not edit>'), ('v==1',), ('ptr', 'Listbox data'), ('ptr', 'Style'), ('sound', 'Step sound'), ('sound', 'Select sound'), ('sound', 'Failed select sound'),)),
    'RallyListBoxLJExNode': ('Node', (('ptr', 'Next node'), ('i32', 'Version <do not edit>'), ('v==1',), ('ptr', 'Listbox data'), ('ptr', 'Style'), ('sound', 'Step sound'), ('sound', 'Select sound'), ('sound', 'Failed select sound'),)),
    'RallyListBoxLJNode': ('Node', (('ptr', 'Next node'), ('ptr', 'Listbox data'), ('font', 'Font'), ('sound', 'Step sound'), ('sound', 'Select sound'), ('sound', 'Failed select sound'),)),
    'RallyListBoxNode': ('Node', (('ptr', 'Next node'), ('ptr', 'Listbox data'), ('font', 'Font'), ('sound', 'Step sound'), ('sound', 'Select sound'), ('sound', 'Failed select sound'),)),
    'RallyMainButtonNode': ('RallyButtonNode', (('ptr', 'Next node'), ('ptr', 'Title data'), ('ptr', 'Title style'), ('ptr', 'Select action'), ('ptr', 'Focus action'), ('ptr', 'Disable data'), ('tex', 'Icon'),)),
    'RallyMovingBackgroundNode': ('Node', (('ptr', 'Next node'), ('tex', 'Picture'), ('bool', 'Rotate'), ('f32', 'Minimum rotation speed (global)'), ('f32', 'Maximum rotation speed (global)'), ('f32', 'Minimum speed X (global)'), ('f32', 'Maximum speed X (global)'), ('f32', 'Minimum speed Y (global)'), ('f32', 'Maximum speed Y (global)'),)),
    'RallyPointsRectangle': ('Node', (('ptr', 'Next node'), ('ptr', 'Player name'), ('ptr', 'Player points'), ('f32', 'Index height'), ('ptr', 'Style'), ('ptr', 'Points Style'), ('f32', 'Number x'), ('f32', 'Text x'), ('f32', 'Text y'), ('f32', 'Points x'),)),
    'RallyRectangle': ('Node', (('ptr', 'Next node'), ('f32', 'Thickness'),)),
    'RallyRectangle2': ('RallyRectangle', (('ptr', 'Next node'), ('f32', 'Thickness'),)),
    'RallyResultRectangle': ('Node', (('ptr', 'Next node'), ('ptr', 'Player name'), ('ptr', 'Player car name'), ('ptr', 'Player time'), ('f32', 'Index height'), ('ptr', 'Style'), ('ptr', 'Time Style'), ('f32', 'Number x'), ('f32', 'Text x'), ('f32', 'Text y'), ('f32', 'Car x'), ('f32', 'Time x'), ('f32', 'Time1 y'), ('f32', 'Time2 y'),)),
    'RallyRotateAroundCoordinateEffect': ('RallyRotateEffect', (('ptr', 'Data'), ('f32', 'Start angle'), ('f32', 'Angle multiplyer'), ('f32', 'X'), ('f32', 'Y'),)),
    'RallyRotateEffect': ('Effect', (('ptr', 'Data'), ('f32', 'Start angle'), ('f32', 'Angle multiplyer'),)),
    'RallySlider': ('Node', (('ptr', 'Next node'), ('ptr', 'Data'), ('f32', 'Min value'), ('f32', 'Max value'), ('f32', 'Step size'), ('ptr', 'MinData'), ('ptr', 'MaxData'), ('ptr', 'StepData'),)),
    'RallySlider2': ('RallySlider', (('ptr', 'Next node'), ('ptr', 'Data'), ('f32', 'Min value'), ('f32', 'Max value'), ('f32', 'Step size'), ('ptr', 'MinData'), ('ptr', 'MaxData'), ('ptr', 'StepData'),)),
    'RallySwooshEffectNode': ('Node', (('ptr', 'Next node'), ('f32', 'Min speed'), ('f32', 'Max speed'), ('f32', 'Min length'), ('f32', 'Max length'),)),
    'RallyTeamButtonNode': ('RallyButtonNode', (('ptr', 'Next node'), ('ptr', 'Title data'), ('ptr', 'Title style'), ('ptr', 'Select action'), ('ptr', 'Focus action'), ('ptr', 'Disable data'),)),
    'RallyTextButtonNode': ('RallyButtonNode', (('ptr', 'Next node'), ('ptr', 'Title data'), ('ptr', 'Title style'), ('ptr', 'Select action'), ('ptr', 'Focus action'), ('ptr', 'Disable data'),)),
    'RallyTextExNode': ('RallyTextNode', (('ptr', 'Next node'), ('i32', 'Version <do not edit>'), ('v==1',), ('f32', 'Show speed'), ('f32', 'Tail length'), ('ptr', 'Data'), ('ptr', 'Style'),)),
    'RallyTextNode': ('Node', (('ptr', 'Next node'), ('f32', 'Show speed'), ('f32', 'Tail length'), ('ptr', 'Data'), ('font', 'Font'),)),
    'RallyTimeNode': ('Node', (('ptr', 'Next node'), ('ptr', 'Time data'), ('ptr', 'Style'),)),
    'RallyTrackButtonNode': ('RallyButtonNode', (('ptr', 'Next node'), ('ptr', 'Title data'), ('ptr', 'Title style'), ('ptr', 'Select action'), ('ptr', 'Focus action'), ('ptr', 'Disable data'), ('ptr', 'Track title'), ('ptr', 'Record style'), ('ptr', 'Record text'), ('ptr', 'Record data'), ('tex', 'Track picture'), ('tex', 'Game type picture'),)),
    'RallyTransformNode': ('Node', (('ptr', 'Next node'), ('f32', 'X'), ('f32', 'Y'), ('f32', 'Width'), ('f32', 'Height'), ('ptr', 'Transformed node'),)),
    'RallyVpResultRectangle': ('Node', (('ptr', 'Next node'), ('ptr', 'Player name'), ('ptr', 'Player car name'), ('ptr', 'Player time'), ('f32', 'Index height'), ('ptr', 'Style'), ('ptr', 'Time Style'), ('f32', 'Number x'), ('f32', 'Text x'), ('f32', 'Text y'), ('f32', 'Car x'), ('f32', 'Time x'), ('f32', 'Time1 y'), ('f32', 'Time2 y'),)),
    'RallyXwmaDataListData': ('DataListData', (('list', 'Data list'),)),
    'ReadyGoNode': ('Node', (('ptr', 'Next node'), ('tex', 'Ready picture'), ('tex', 'Go picture'), ('ptr', 'Time'),)),
    'RecordNode': ('Node', (('ptr', 'Next node'), ('ptr', 'Track'), ('ptr', 'From car list'), ('ptr', 'To car list'), ('ptr', 'Style'), ('f32', 'Car delta X'), ('f32', 'Time delta X'), ('f32', 'Date delta X'), ('ptr', 'Date format'), ('ptr', 'Track has records'),)),
    'RememberingTabstopManagerNode': ('TabstopManagerNode', (('ptr', 'Next node'),)),
    'RemoveEventAction': ('Action', ()),
    'ReplayButtonNode': ('Node', (('ptr', 'Next node'), ('ptr', 'Select action'), ('tex', 'Picture'), ('f32', 'Zoom speed (static)'), ('f32', 'Zoom size (static)'),)),
    'RightAlignedSizeStyle': ('SizeStyleExtra', (('font', 'Font handle'), ('f32', 'Size constant'),)),
    'RightAlignedStyle': ('Style', (('font', 'Font handle'),)),
    'RotateAroundCoordinateEffect': ('RotateEffect', (('ptr', 'Start angle'), ('ptr', 'Angle multiplyer'), ('ptr', 'X'), ('ptr', 'Y'),)),
    'RotateEffect': ('Effect', (('ptr', 'Start angle'), ('ptr', 'Angle multiplyer'),)),
    'RowDistanceSizeStyle': ('SizeStyleExtra', (('font', 'Font handle'), ('f32', 'Size constant'), ('f32', 'Row distance'),)),
    'RowDistanceStyle': ('Style', (('font', 'Font handle'), ('f32', 'Row distance'),)),
    'RowDistanceStyleExtra': ('Style', (('font', 'Font handle'), ('f32', 'Row distance'),)),
    'SaveCarSettingsAction': ('Action', (('ptr', 'Save name'), ('ptr', 'Player index'),)),
    'SaveProfileAction': ('Action', (('ptr', 'Save name'), ('ptr', 'Difficult level'), ('ptr', 'Profile name'),)),
    'ScaleNode': ('Node', (('ptr', 'Next node'), ('ptr', 'Width scale'), ('ptr', 'Height scale'),)),
    'ScaleYStyle': ('Style', (('font', 'Font handle'),)),
    'ScoreCounterNode': ('Node', (('ptr', 'Next node'), ('ptr', 'Score list'), ('ptr', 'Style'), ('f32', 'Counter speed'),)),
    'SetFocusAction': ('Action', (('ptr', 'x'), ('ptr', 'y'),)),
    'SetMultiIngameListNodeAction': ('Action', (('ptr', 'Target multiplayer node'), ('i32', 'Index'), ('ptr', 'New ingame list node'),)),
    'SetPathAction': ('Action', (('ptr', 'Path node'), ('ptr', 'Destination node'), ('f32', 'In time'), ('f32', 'Out time'), ('f32', 'In wait time'), ('f32', 'Out wait time'), ('bool', 'Paint outnode over innode'),)),
    'SetStringAction': ('Action', (('ptr', 'Variable'), ('ptr', 'Data'),)),
    'SetVariableAction': ('Action', (('ptr', 'Variable'), ('ptr', 'Data'),)),
    'SetVariableArrayAction': ('SetVariableAction', (('ptr', 'Variable'), ('ptr', 'Data'), ('ptr', 'Index'),)),
    'SetVariableSineAction': ('SetVariableSoftAction', (('ptr', 'Variable'), ('ptr', 'Data'), ('f32', 'Speed'), ('f32', 'Braking distance'),)),
    'SetVariableSinusAction': ('SetVariableSineAction', (('ptr', 'Variable'), ('ptr', 'Data'), ('f32', 'Speed'), ('f32', 'Braking distance'),)),
    'SetVariableSoftAction': ('SetVariableAction', (('ptr', 'Variable'), ('ptr', 'Data'), ('f32', 'Speed'),)),
    'ShowEffectNode': ('EffectNode', (('ptr', 'Next node'), ('ptr', 'Effect'),)),
    'SingleLineSizeStyle': ('SizeStyle', (('font', 'Font handle'), ('f32', 'Size constant'),)),
    'SingleLineSizeStyleExtra': ('SizeStyleExtra', (('font', 'Font handle'), ('f32', 'Size constant'),)),
    'SingleLineStyle': ('Style', (('font', 'Font handle'),)),
    'SinMoveEffect': ('MoveEffect', (('ptr', 'Move length'), ('ptr', 'Move direction'),)),
    'SizeStyle': ('Style', (('font', 'Font handle'), ('f32', 'Size constant'),)),
    'SizeStyleExtra': ('Style', (('font', 'Font handle'), ('f32', 'Size constant'),)),
    'SliderNode': ('Node', (('ptr', 'Next node'), ('ptr', 'Cursor node'), ('ptr', 'Data'), ('f32', 'Minimum value'), ('f32', 'Maximum value'), ('f32', 'Number visible'),)),
    'SongData': ('WstringData', (('wstr', 'Wstring <do not edit>'),)),
    'SoundAction': ('Action', (('sound', 'Sound'),)),
    'SplitAction': ('Action', (('ptr', 'Action 1'), ('ptr', 'Action 2'),)),
    'SplitEffect': ('Effect', (('ptr', 'Effect 1'), ('ptr', 'Effect 2'),)),
    'SplitNode': ('Node', (('ptr', 'Next node'), ('ptr', 'Split node'),)),
    'StackPathNode': ('PathNode', (('ptr', 'Next node'),)),
    'StickyNode': ('Node', (('ptr', 'Next node'), ('ptr', 'Variable'), ('ptr', 'Data'),)),
    'StringData': ('Data', (('str', 'String <do not edit>'),)),
    'StringRefData': ('Data', ()),
    'Style': ('Object', (('font', 'Font handle'),)),
    'SubData': ('OperatorData', (('ptr', 'Data 1'), ('ptr', 'Data 2'),)),
    'System': ('Object', ()),
    'TabstopManagerNode': ('Node', (('ptr', 'Next node'),)),
    'TabstopNode': ('Node', (('ptr', 'Next node'),)),
    'TACheckpointMeterNode': ('Node', (('ptr', 'Next node'), ('ptr', 'Current position'), ('ptr', 'Total Distance'), ('ptr', 'Checkpoints'), ('ptr', 'Current lap'), ('ptr', 'Lap count'), ('ptr', 'Player checkpoint times'),)),
    'TextButtonNode': ('Node', (('ptr', 'Next node'), ('ptr', 'String'), ('ptr', 'Style'), ('ptr', 'Focus action'), ('ptr', 'Select action'),)),
    'TextNode': ('Node', (('ptr', 'Next node'), ('ptr', 'String'), ('ptr', 'Style'),)),
    'TimeboxNode': ('Node', (('ptr', 'Next node'), ('f32', 'Red'), ('f32', 'Green'), ('f32', 'Blue'), ('f32', 'Alpha'), ('f32', 'Title delta height'), ('f32', 'Red'), ('f32', 'Green'), ('f32', 'Blue'), ('f32', 'Alpha'), ('bool', 'Corner cut side (Left = false, Right = true)'), ('f32', 'Corner cut delta size'),)),
    'TimeData': ('Data', (('ptr', 'Data'),)),
    'TimeoutActionNode': ('ActionNode', (('ptr', 'Next node'), ('ptr', 'Action'), ('f32', 'Timeout time'),)),
    'TitleTextNode': ('TextNode', (('ptr', 'Next node'), ('ptr', 'String'), ('ptr', 'Style'), ('f32', 'Text offset x'), ('f32', 'Text offset y'),)),
    'ToggleVariableAction': ('Action', (('ptr', 'Variable'),)),
    'TrackMapNode': ('Node', (('ptr', 'Next node'),)),
    'TransformNode': ('Node', (('ptr', 'Next node'), ('f32', 'X'), ('f32', 'Y'), ('f32', 'Width'), ('f32', 'Height'), ('ptr', 'Transformed node'),)),
    'TransitionalEffectNode': ('EffectNode', (('ptr', 'Next node'), ('ptr', 'Effect'),)),
    'TransitionalHideEffectNode': ('EffectNode', (('ptr', 'Next node'), ('ptr', 'Effect'),)),
    'TransitionalShowEffectNode': ('EffectNode', (('ptr', 'Next node'), ('ptr', 'Effect'),)),
    'TranslateNode': ('Node', (('ptr', 'Next node'), ('ptr', 'X'), ('ptr', 'Y'),)),
    'Tree': ('Object', (('bool', 'Bool'),)),
    'TypeEvent': ('Event', (('i8', 'Input index (0 == all indexes)'), ('enum', 'Event type'),)),
    'UnlockPadIndexAction': ('Action', ()),
    'UnlockPointerAction': ('Action', ()),
    'VariableEffectNode': ('EffectNode', (('ptr', 'Next node'), ('ptr', 'Effect'), ('ptr', 'Effect level'),)),
    'VariablePictureNode': ('Node', (('ptr', 'Next node'), ('ptr', 'First part'), ('ptr', 'Middle part'), ('ptr', 'Last part'),)),
    'VariableTabstopNode': ('TabstopNode', (('ptr', 'Next node'), ('ptr', 'Variable'),)),
    'VertexColorEffect': ('Effect', (('f32', 'Top left red'), ('f32', 'Top left green'), ('f32', 'Top left blue'), ('f32', 'Top left alpha'), ('f32', 'Top right red'), ('f32', 'Top right green'), ('f32', 'Top right blue'), ('f32', 'Top right alpha'), ('f32', 'Bottom right red'), ('f32', 'Bottom right green'), ('f32', 'Bottom right blue'), ('f32', 'Bottom right alpha'), ('f32', 'Bottom left red'), ('f32', 'Bottom left green'), ('f32', 'Bottom left blue'), ('f32', 'Bottom left alpha'),)),
    'VerticalScrollExNode': ('VerticalScrollNode', (('ptr', 'Next node'), ('i32', 'Version <do not edit>'), ('v==1',), ('ptr', 'Text'), ('ptr', 'Style'), ('f32', 'Scroll speed'), ('ptr', 'Scroll speed multiplier'), ('ptr', 'Restart toggle'),)),
    'VerticalScrollNode': ('Node', (('ptr', 'Next node'), ('ptr', 'Text'), ('font', 'Font'), ('f32', 'Scroll speed'), ('ptr', 'Scroll speed multiplier'), ('ptr', 'Restart toggle'),)),
    'VirtualKeyboardExNode': ('VirtualKeyboardNode', (('ptr', 'Next node'), ('i32', 'Version <do not edit>'), ('ptr', 'String'), ('ptr', 'Ok action'), ('ptr', 'Erase string'), ('ptr', 'Ok string'), ('ptr', 'Back string'), ('ptr', 'Style'), ('f32', 'Step size'), ('ptr', 'Back action'), ('f32', 'Max string width'), ('v>=2',), ('i32', 'Max characters'),)),
    'VirtualKeyboardNode': ('Node', (('ptr', 'Next node'), ('ptr', 'String'), ('ptr', 'Ok action'), ('ptr', 'Erase string'), ('ptr', 'Ok string'), ('ptr', 'Back string'), ('font', 'Font'), ('f32', 'Step size'), ('ptr', 'Back action'),)),
    'VolumedSoundAction': ('SoundAction', (('sound', 'Sound'), ('f32', 'Volume (0-1)'),)),
    'VpCarSelectionData': ('Data', (('tex', 'PictureHandle'), ('ptr', 'Data'),)),
    'VpCarSelectionExxData': ('VpCarSelectionData', (('tex', 'PictureHandle'), ('ptr', 'Data'), ('ptr', 'Locked'), ('ptr', 'Bonus'),)),
    'VpCarSelectNode': ('Node', (('ptr', 'Next node'), ('f32', 'Picture size'), ('f32', 'Picture spacing'), ('list', 'Picture list'), ('ptr', 'Player car name (array)'), ('tex', 'Player 1 picture'), ('tex', 'Player 2 picture'), ('tex', 'Player 3 picture'), ('tex', 'Player 4 picture'), ('ptr', 'Selection finished action'), ('ptr', 'Last input index'),)),
    'VpDistanceMeterNode': ('Node', (('ptr', 'Next node'), ('ptr', 'Checkpoints (array)'), ('ptr', 'Player name'), ('ptr', 'Player distance (array)'), ('ptr', 'Total distance'), ('tex', 'Picture 1'), ('tex', 'Picture 2'), ('tex', 'Picture 3'), ('tex', 'Picture 4'), ('ptr', 'Lap count'),)),
    'WindowNode': ('TransformNode', (('ptr', 'Next node'), ('f32', 'X'), ('f32', 'Y'), ('f32', 'Width'), ('f32', 'Height'), ('ptr', 'Transformed node'),)),
    'WrongWayNode': ('Node', (('ptr', 'Next node'), ('tex', 'Picture'), ('ptr', 'Player distance'), ('f32', 'Back time'), ('f32', 'Still time'), ('tex', 'Back picture'),)),
    'WstringData': ('Data', (('wstr', 'Wstring <do not edit>'),)),
    'XboxWmaDataListData': ('DataListData', (('list', 'Data list'),)),
    'ZoomNode': ('Node', (('ptr', 'Next node'), ('ptr', 'Z'),)),
}

# Older layouts found in the data that the shipped exe's readers do NOT match (the exe over-reads them and
# then seeks back to the object end, FUN_005d7d30 "Reading differs from saved file").  Detected by body size /
# content; every byte is still accounted for.
#   inline : MoveEffect / RotateEffect store floats where the current class has FloatData pointers
#   cheat  : CheatEvent stores 5 i32 button codes instead of a StringData
#   cut    : the object ends before the class's trailing fields (they keep the constructor defaults)
LEGACY_CUT = {   # class -> first field missing in the legacy layout
    'OptionListData': 'Left Button X',
    'RallyButtonListNode': 'Focus action',
    'RallySlider': 'MinData',
    'ProfileListBoxData': 'Default action',
    'ControllerInputListBoxData': 'Reset string',
}


class MemeError(Exception):
    pass


class _Reader:
    __slots__ = ('d', 'p', 'table', 'base', 'stack')

    def __init__(self, data: bytes):
        self.d = data
        self.p = 0
        self.table: list[str] = []
        self.stack: list[str] = []

    def take(self, n: int, end: int) -> bytes:
        if self.p + n > end:
            raise MemeError('read past object end at %d (+%d > %d) in %s' % (self.p, n, end, '/'.join(self.stack)))
        b = self.d[self.p:self.p + n]
        self.p += n
        return b

    def u8(self, e): return self.take(1, e)[0]
    def u16(self, e): return struct.unpack('<H', self.take(2, e))[0]
    def u32(self, e): return struct.unpack('<I', self.take(4, e))[0]
    def i32(self, e): return struct.unpack('<i', self.take(4, e))[0]
    def f32(self, e): return struct.unpack('<f', self.take(4, e))[0]

    def name(self, e):
        i = self.u16(e)
        if i == 0:
            return ''
        if i > len(self.table):
            raise MemeError('string index %d > %d at %d in %s' % (i, len(self.table), self.p - 2, '/'.join(self.stack)))
        return self.table[i - 1]


def _short(cn: str) -> str:
    return cn[12:] if cn.startswith('dice::meme::') else cn


def _ref(r: _Reader, end: int):
    """One object reference (FUN_005d7d30)."""
    st = r.p
    size = r.u32(end)
    on = r.name(end)
    cn = r.name(end)
    oend = st + size
    if size < 8 or oend > end:
        raise MemeError('bad object size %d at %d in %s' % (size, st, '/'.join(r.stack)))
    if not cn:
        if size != 8:
            raise MemeError('classless reference with size %d at %d' % (size, st))
        return {'$ref': on} if on else None
    cls = _short(cn)
    if cls not in CLASSES:
        raise MemeError('unknown class %s at %d' % (cn, st))
    o = {'$class': cls, '$name': on, '$at': st}
    _body(r, o, cls, oend)
    if r.p != oend:
        o['$unread'] = r.d[r.p:oend].hex()
        r.p = oend
    return o


def _tree(r: _Reader, end: int, which: str):
    """dice::meme::Tree node (FUN_005f3380 'A' / 005f3450 'B' / 005f3500 'C'): bool present, node fields
    (NavigateTree node: Description, Action), child subtree (A), then the +8 chain (B) and/or +4 chain (C)."""
    if not r.u8(end):
        return None
    n = {'Description': _ref(r, end), 'Action': _ref(r, end), 'child': _tree(r, end, 'A')}
    if which in 'AB':
        n['next'] = _tree(r, end, 'B')
    if which in 'AC':
        n['prev'] = _tree(r, end, 'C')
    return n


def _value(r: _Reader, kind: str, end: int):
    if kind == 'ptr':
        return _ref(r, end)
    if kind == 'f32':
        return r.f32(end)
    if kind in ('i32', 'enum'):
        return r.i32(end)
    if kind == 'bool':
        return r.u8(end)
    if kind == 'i8':
        return struct.unpack('<b', r.take(1, end))[0]
    if kind == 'str':
        n = r.u32(end)
        return r.take(n, end).decode('latin-1')
    if kind == 'wstr':
        n = r.u32(end)
        return r.take(2 * n, end).decode('utf-16-le')
    if kind in ('tex', 'font', 'sound'):
        n = r.u8(end)
        return r.take(n, end).decode('latin-1')
    if kind == 'list':
        out = []
        while True:
            x = _ref(r, end)
            if x is None:
                return out
            out.append(x)
    raise MemeError('kind ' + kind)


def _body(r: _Reader, o: dict, cls: str, end: int):
    r.stack.append(cls)
    remain = end - r.p
    if cls == 'NavigateTree':
        o['tree'] = _tree(r, end, 'A')
        r.stack.pop()
        return
    if cls in ('MoveEffect', 'RotateEffect') and _legacy_inline(r, cls, remain):
        o['$legacy'] = 'inline'
        if cls == 'RotateEffect':
            o['(legacy pointer)'] = _ref(r, end)
            o['Start angle'], o['Angle multiplyer'] = r.f32(end), r.f32(end)
        else:
            o['Move length'], o['Move direction'] = r.f32(end), r.f32(end)
        r.stack.pop()
        return
    if cls == 'CheatEvent' and remain == 21 and struct.unpack_from('<I', r.d, r.p + 1)[0] != 20:
        o['$legacy'] = 'cheat'
        o['Input index (0 == all indexes)'] = struct.unpack('<b', r.take(1, end))[0]
        o['(legacy buttons)'] = [r.i32(end) for _ in range(5)]
        r.stack.pop()
        return
    version = None
    cut = LEGACY_CUT.get(cls)
    seen: dict[str, int] = {}
    fields = CLASSES[cls][1]
    i = 0
    while i < len(fields):
        f = fields[i]
        kind = f[0]
        if kind == 'v==1':
            if version != 1:
                break                      # the exe's read returns false; the caller skips the rest
            i += 1
            continue
        if kind == 'v>=2':
            if version is None or version < 2:
                i += 2
                continue
            i += 1
            continue
        label = f[1]
        if cut and label == cut and r.p == end:
            o['$legacy'] = 'cut'
            break
        v = _value(r, kind, end)
        if label == 'Version <do not edit>':
            version = v
        k = seen.get(label, 0) + 1
        seen[label] = k
        o[label if k == 1 else '%s #%d' % (label, k)] = v
        i += 1
    r.stack.pop()


def _legacy_inline(r: _Reader, cls: str, remain: int) -> bool:
    if cls == 'MoveEffect':
        return remain == 8
    # RotateEffect legacy: a null pointer record and two floats (16 bytes) instead of two pointers
    if remain != 16:
        return False
    return r.d[r.p + 8:r.p + 16] != b'\x08\x00\x00\x00\x00\x00\x00\x00' and \
        r.d[r.p:r.p + 8] == b'\x08\x00\x00\x00\x00\x00\x00\x00'


def parse(data: bytes) -> dict:
    r = _Reader(data)
    n = data[0]
    if data[1:1 + n] != MAGIC:
        raise MemeError('not a MemeFile 2.0')
    r.p = 1 + n
    while True:
        n = r.u8(len(data))
        if n == 0:
            break
        r.table.append(r.take(n, len(data)).decode('latin-1'))
    r.base = r.p
    cn = r.name(len(data))
    cls = _short(cn)
    if cls not in CLASSES:
        raise MemeError('unknown root class ' + cn)
    root = {'$class': cls, '$name': '', '$at': r.p - 2}
    _body(r, root, cls, len(data))
    if r.p != len(data):
        raise MemeError('%d trailing bytes' % (len(data) - r.p))
    return {'strings': r.table, 'root': root}


def parse_file(path: str) -> dict:
    with open(path, 'rb') as f:
        return parse(f.read())


def is_meme(path: str) -> bool:
    with open(path, 'rb') as f:
        return f.read(13) == b'\x0c' + MAGIC


def all_files(root: str | None = None) -> list[str]:
    """Every meme file in the extracted archives (by magic, not by name)."""
    root = root or FULL
    out = []
    for dp, dn, fn in os.walk(root):
        dn.sort()
        for f in sorted(fn):
            p = os.path.join(dp, f)
            try:
                if os.path.getsize(p) >= 13 and is_meme(p):
                    out.append(p)
            except OSError:
                pass
    return out


def walk(o, fn, path=()):
    """Call fn(obj, path) for every object dict in a parsed graph (depth first, file order)."""
    if isinstance(o, dict):
        if '$class' in o:
            fn(o, path)
        for k, v in o.items():
            if isinstance(v, (dict, list)):
                walk(v, fn, path + (k,))
    elif isinstance(o, list):
        for i, v in enumerate(o):
            walk(v, fn, path + (i,))


def _main(argv):
    import argparse
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[1])
    ap.add_argument('cmd', choices=['dump', 'show', 'stats'])
    ap.add_argument('paths', nargs='*')
    ap.add_argument('--out', default=os.path.join(REPO, 'research', 'formats', 'meme_dump.json'))
    a = ap.parse_args(argv)
    if a.cmd == 'show':
        for p in a.paths:
            p = p if os.path.isabs(p) or os.path.exists(p) else os.path.join(FULL, p)
            print(json.dumps(parse_file(p), indent=1, ensure_ascii=False))
        return 0
    files = all_files()
    docs, bad = {}, []
    counts: dict[str, int] = {}
    legacy: dict[str, int] = {}
    unread = 0
    nbytes = 0
    for p in files:
        rel = os.path.relpath(p, FULL).replace(os.sep, '/')
        try:
            d = parse_file(p)
        except MemeError as e:
            bad.append((rel, str(e)))
            continue
        nbytes += os.path.getsize(p)
        docs[rel] = d

        def count(o, path):
            nonlocal unread
            counts[o['$class']] = counts.get(o['$class'], 0) + 1
            if '$legacy' in o:
                legacy[o['$class'] + ':' + o['$legacy']] = legacy.get(o['$class'] + ':' + o['$legacy'], 0) + 1
            if '$unread' in o:
                unread += 1
        walk(d['root'], count)
    print('meme files: %d parsed (%d bytes, every byte consumed), %d failed' % (len(docs), nbytes, len(bad)))
    print('classes used: %d of %d; objects: %d' % (len(counts), len(CLASSES), sum(counts.values())))
    print('legacy layouts:', legacy, ' objects with exe-skipped bytes:', unread)
    for b in bad:
        print('FAIL', *b)
    if a.cmd == 'stats':
        for c, n in sorted(counts.items(), key=lambda x: -x[1]):
            print('%6d %s' % (n, c))
    if a.cmd == 'dump':
        os.makedirs(os.path.dirname(a.out), exist_ok=True)
        with open(a.out, 'w') as f:
            json.dump({'format': 'MemeFile 2.0', 'files': docs}, f, ensure_ascii=False, separators=(',', ':'))
        print('wrote', a.out)
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(_main(sys.argv[1:]))
