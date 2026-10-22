# Regenerate Salem's own vector mark and multi-resolution Windows icon.
# Uses Windows/.NET only; no network, font or image-library dependency.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$destination = Join-Path $root 'ui/public'
[IO.Directory]::CreateDirectory($destination) | Out-Null
$paths = @(
    @{ Fill='#534069'; Stroke=$null; Width=0; Ops=@(@('M',14,34),@('L',12,10),@('L',26,19),@('C',30,17,34,17,38,19),@('L',52,10),@('L',50,34),@('C',50,48,43,55,32,55),@('C',21,55,14,48,14,34),@('Z')) },
    @{ Fill='#aa95c3'; Stroke=$null; Width=0; Ops=@(@('M',18,18),@('L',19,29),@('L',26,23),@('Z'),@('M',46,18),@('L',45,29),@('L',38,23),@('Z')) },
    @{ Fill=$null; Stroke='#ffffff'; Width=3; Ops=@(@('M',22,36),@('L',27,36),@('M',37,36),@('L',42,36)) },
    @{ Fill=$null; Stroke='#d2c4e3'; Width=2; Ops=@(@('M',29,43),@('L',32,46),@('L',35,43)) }
)
$svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#eee9f5"/>'
foreach ($shape in $paths) {
    $data = ($shape.Ops | ForEach-Object { $_ -join ' ' }) -join ' '
    $fill = if ($shape.Fill) { $shape.Fill } else { 'none' }
    $stroke = if ($shape.Stroke) { ' stroke="'+$shape.Stroke+'" stroke-width="'+$shape.Width+'" stroke-linecap="round" stroke-linejoin="round"' } else { '' }
    $svg += '<path d="'+$data+'" fill="'+$fill+'"'+$stroke+'/>'
}
$svg += '</svg>'
[IO.File]::WriteAllText((Join-Path $destination 'salem.svg'),$svg,[Text.UTF8Encoding]::new($false))
$frames = [Collections.Generic.List[byte[]]]::new()
$sizes = @(16,20,24,32,40,48,64,128,256)
foreach ($size in $sizes) {
    $bitmap = [Drawing.Bitmap]::new($size,$size,[Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.ScaleTransform(($size/64.0),($size/64.0))
        $plate = [Drawing.Drawing2D.GraphicsPath]::new()
        try {
            $plate.AddArc(0,0,28,28,180,90); $plate.AddArc(36,0,28,28,270,90)
            $plate.AddArc(36,36,28,28,0,90); $plate.AddArc(0,36,28,28,90,90); $plate.CloseFigure()
            $brush = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml('#eee9f5'))
            try { $graphics.FillPath($brush,$plate) } finally { $brush.Dispose() }
        } finally { $plate.Dispose() }
        foreach ($shape in $paths) {
            $path = [Drawing.Drawing2D.GraphicsPath]::new(); [single]$x=0; [single]$y=0
            try {
                foreach ($op in $shape.Ops) {
                    switch ($op[0]) {
                        'M' { $path.StartFigure(); $x=$op[1]; $y=$op[2] }
                        'L' { $path.AddLine($x,$y,[single]$op[1],[single]$op[2]); $x=$op[1]; $y=$op[2] }
                        'C' { $path.AddBezier($x,$y,[single]$op[1],[single]$op[2],[single]$op[3],[single]$op[4],[single]$op[5],[single]$op[6]); $x=$op[5]; $y=$op[6] }
                        'Z' { $path.CloseFigure() }
                    }
                }
                if ($shape.Fill) {
                    $brush = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml($shape.Fill))
                    try { $graphics.FillPath($brush,$path) } finally { $brush.Dispose() }
                }
                if ($shape.Stroke) {
                    $pen = [Drawing.Pen]::new([Drawing.ColorTranslator]::FromHtml($shape.Stroke),[single]$shape.Width)
                    $pen.StartCap=[Drawing.Drawing2D.LineCap]::Round; $pen.EndCap=[Drawing.Drawing2D.LineCap]::Round; $pen.LineJoin=[Drawing.Drawing2D.LineJoin]::Round
                    try { $graphics.DrawPath($pen,$path) } finally { $pen.Dispose() }
                }
            } finally { $path.Dispose() }
        }
        $memory = [IO.MemoryStream]::new()
        try { $bitmap.Save($memory,[Drawing.Imaging.ImageFormat]::Png); $frames.Add($memory.ToArray()) } finally { $memory.Dispose() }
    } finally { $graphics.Dispose(); $bitmap.Dispose() }
}
$memory = [IO.MemoryStream]::new(); $writer = [IO.BinaryWriter]::new($memory)
try {
    $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$sizes.Count)
    $offset = 6+16*$sizes.Count
    for ($i=0;$i -lt $sizes.Count;$i++) {
        $dimension = if ($sizes[$i] -eq 256) { 0 } else { $sizes[$i] }
        $writer.Write([byte]$dimension); $writer.Write([byte]$dimension); $writer.Write([byte]0); $writer.Write([byte]0)
        $writer.Write([uint16]1); $writer.Write([uint16]32); $writer.Write([uint32]$frames[$i].Length); $writer.Write([uint32]$offset)
        $offset += $frames[$i].Length
    }
    foreach ($frame in $frames) { $writer.Write([byte[]]$frame) }
    $writer.Flush(); [IO.File]::WriteAllBytes((Join-Path $destination 'salem.ico'),$memory.ToArray())
} finally { $writer.Dispose(); $memory.Dispose() }
Write-Output 'Generated ui/public/salem.svg and salem.ico (16-256 px).'
