" Vim configuration file

" Basic settings
set number              " Show line numbers
set relativenumber      " Show relative line numbers
set tabstop=4           " Number of spaces tabs count for
set shiftwidth=4        " Number of spaces to use for autoindent
set expandtab           " Use spaces instead of tabs
set smartindent         " Smart autoindenting
set autoindent          " Autoindent new lines
set wrap                " Wrap long lines
set showcmd             " Show command in bottom bar
set wildmenu            " Visual autocomplete for command menu
set hlsearch            " Highlight search results
set incsearch            " Search as characters are entered
set ignorecase          " Ignore case when searching
set smartcase           " Override ignorecase if uppercase letters present
set scrolloff=8         " Number of lines to keep above/below cursor
set sidescrolloff=8     " Number of columns to keep left/right of cursor
set mouse=a             " Enable mouse usage
set clipboard=unnamedplus " Use system clipboard

" Appearance
syntax on               " Enable syntax highlighting
set background=dark     " Dark background
set cursorline          " Highlight current line
set colorcolumn=80      " Highlight column 80

" File handling
set encoding=utf8       " Use UTF-8 encoding
set fileencoding=utf8   " Use UTF-8 for files
set nobackup            " Don't create backup files
set nowritebackup       " Don't create backup files
set noswapfile          " Don't use swap files

" Netrw settings
let g:netrw_banner=0    " Disable banner
let g:netrw_liststyle=3 " Tree view
let g:netrw_winsize=30  " 30% of window width

" Custom mappings
let mapleader = ","    " Set leader key

" Navigation
nnoremap <C-h> <C-w>h
nnoremap <C-j> <C-w>j
nnoremap <C-k> <C-w>k
nnoremap <C-l> <C-w>l

" Search
nnoremap <leader>h :nohlsearch<CR>

" Save and quit
nnoremap <leader>w :w<CR>
nnoremap <leader>q :q<CR>

" Split navigation
nnoremap <leader>s :split<CR>
nnoremap <leader>v :vsplit<CR>

" Plugin management (if using vim-plug)
" Specify plugins here
" call plug#begin('~/.vim/plugged')
" Plug 'preservim/nerdtree'
" Plug 'tpope/vim-fugitive'
" call plug#end()